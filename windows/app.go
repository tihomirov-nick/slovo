package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

// vadModel is Silero VAD for whisper.cpp, from Resources; the build packs it with the tools.
const vadModel = "ggml-silero-v6.2.0.bin"

type Settings struct {
	Model       string `json:"model"`
	Language    string `json:"language"`
	Prompt      string `json:"prompt"`
	SkipSilence bool   `json:"skipSilence"`
	Accurate    bool   `json:"accurate"`
	Format      string `json:"format"`
	CaseMode    string `json:"caseMode"`
}

var defaultSettings = Settings{Language: "ru", SkipSilence: true, Accurate: true, Format: "text", CaseMode: "original"}

// Segment is a phrase recognized by Whisper with its timing in seconds.
type Segment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

// Job is the recognition of one file, or another pass over the same audio.
type Job struct {
	ID            int       `json:"id"`
	Status        string    `json:"status"`   // working, done, error, cancelled
	Step          string    `json:"step"`     // audio, model, speech
	Progress      float64   `json:"progress"` // 0…1 of the step, -1 while unknown
	FileName      string    `json:"fileName"`
	Duration      float64   `json:"duration"`
	ModelName     string    `json:"modelName"`
	Language      string    `json:"language"`
	Error         string    `json:"error,omitempty"`
	SpeechStarted int64     `json:"speechStarted,omitempty"` // Unix ms, for the remaining time
	Elapsed       float64   `json:"elapsed"`
	SegmentCount  int       `json:"segmentCount"`
	Segments      []Segment `json:"segments,omitempty"`

	wav    string // 16 kHz mono audio, kept for another pass
	cancel context.CancelFunc
	done   chan struct{}
	began  time.Time
}

type startRequest struct {
	input  string // file to read; empty for another pass over the current audio
	upload bool   // input is a copy made for the job, deleted once read
	name   string
	model  string // for another pass; empty: the settings
	lang   string
}

type App struct {
	paths      Paths
	tools      string
	token      string
	host       string
	openWindow func()
	hub        *Hub

	mu              sync.Mutex
	settings        Settings
	job             *Job
	jobs            int
	downloads       map[string]*download
	failures        map[string]string // download errors by model id
	lastJobEvent    time.Time
	lastModelsEvent time.Time
}

var errBusy = errors.New("Slovo уже распознаёт файл")

func newApp(paths Paths, tools string) *App {
	// Audio left by an earlier run.
	entries, _ := os.ReadDir(paths.Work)
	for _, entry := range entries {
		os.RemoveAll(filepath.Join(paths.Work, entry.Name()))
	}
	a := &App{paths: paths, tools: tools, token: randomToken(), hub: newHub(), settings: defaultSettings,
		downloads: map[string]*download{}, failures: map[string]string{}}
	if data, err := os.ReadFile(filepath.Join(paths.Root, "settings.json")); err == nil {
		json.Unmarshal(data, &a.settings)
	}
	return a
}

// updateSettings takes the fields the page sent.
func (a *App) updateSettings(raw []byte) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	next := a.settings
	if err := json.Unmarshal(raw, &next); err != nil {
		return err
	}
	a.settings = next
	data, _ := json.MarshalIndent(next, "", "  ")
	return os.WriteFile(filepath.Join(a.paths.Root, "settings.json"), data, 0o644)
}

func (a *App) state() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	var job *Job
	if a.job != nil {
		copied := *a.job
		copied.Segments = append([]Segment{}, a.job.Segments...)
		job = &copied
	}
	return map[string]any{"version": version, "settings": a.settings, "models": a.modelStatesLocked(), "job": job}
}

func (a *App) busy() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.job != nil && a.job.Status == "working"
}

// publishJobLocked sends the job without its phrases (they go one by one); `force` skips the rate limit of progress.
func (a *App) publishJobLocked(force bool) {
	if a.job == nil || (!force && time.Since(a.lastJobEvent) < 150*time.Millisecond) {
		return
	}
	a.lastJobEvent = time.Now()
	info := *a.job
	info.Segments = nil
	a.hub.send("job", info)
}

func (a *App) start(req startRequest) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.job != nil && a.job.Status == "working" {
		if req.upload {
			os.Remove(req.input)
		}
		return errBusy
	}
	settings := a.settings
	if req.model != "" {
		settings.Model = req.model
	}
	if req.lang != "" {
		settings.Language = req.lang
	}
	model, ok := a.pickModelLocked(settings.Model)
	if !ok {
		if req.upload {
			os.Remove(req.input)
		}
		return errors.New("Сначала скачайте модель распознавания")
	}
	previous := a.job
	ctx, cancel := context.WithCancel(context.Background())
	job := &Job{ID: a.jobs + 1, Status: "working", Step: "audio", Progress: -1, FileName: req.name,
		ModelName: model.Name, Language: settings.Language, cancel: cancel, done: make(chan struct{}), began: time.Now()}
	if req.input == "" {
		if previous == nil || previous.wav == "" {
			cancel()
			return errors.New("Нет файла для повторного распознавания")
		}
		job.wav, job.Duration, job.FileName = previous.wav, previous.Duration, previous.FileName
	} else if previous != nil && previous.wav != "" {
		os.Remove(previous.wav)
	}
	a.jobs++
	a.job = job
	a.publishJobLocked(true)
	go a.run(ctx, job, req, settings, model)
	return nil
}

func (a *App) run(ctx context.Context, job *Job, req startRequest, settings Settings, model ModelState) {
	defer close(job.done)
	release := keepAwake()
	defer release()
	err := func() error {
		if job.wav == "" {
			wav, duration, err := a.extractAudio(ctx, job, req.input)
			if req.upload {
				os.Remove(req.input)
			}
			if err != nil {
				return err
			}
			a.mu.Lock()
			job.wav, job.Duration = wav, duration
			a.mu.Unlock()
		}
		return a.recognize(ctx, job, settings, model)
	}()
	a.mu.Lock()
	defer a.mu.Unlock()
	job.Elapsed = time.Since(job.began).Seconds()
	switch {
	case ctx.Err() != nil:
		job.Status = "cancelled"
	case err != nil:
		job.Status, job.Error = "error", err.Error()
	default:
		job.Status, job.Progress = "done", 1
	}
	a.publishJobLocked(true)
}

func (a *App) cancelJob() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.job != nil && a.job.Status == "working" {
		a.job.cancel()
	}
}

// reset closes the result: the window goes back to the drop zone.
func (a *App) reset() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.job == nil || a.job.Status == "working" {
		return
	}
	if a.job.wav != "" {
		os.Remove(a.job.wav)
	}
	a.job = nil
	a.hub.send("job", nil)
}

func (a *App) shutdown() {
	a.mu.Lock()
	job := a.job
	for _, d := range a.downloads {
		d.cancel()
	}
	a.mu.Unlock()
	if job != nil && job.Status == "working" {
		job.cancel()
		select {
		case <-job.done:
		case <-time.After(5 * time.Second):
		}
	}
}

// waitUntilClosed returns once the window is closed: no page has been connected for a few seconds. Seconds are counted
// by ticks, so after the computer wakes from sleep the page has time to reconnect.
func (a *App) waitUntilClosed() {
	idle := 0
	for range time.Tick(time.Second) {
		clients, ever := a.hub.count()
		switch {
		case clients > 0:
			idle = 0
		case ever && idle >= 8, !ever && idle >= 120:
			return
		default:
			idle++
		}
	}
}

func (a *App) command(ctx context.Context, tool string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, filepath.Join(a.tools, tool+exeSuffix), args...)
	cmd.Dir = a.paths.Root
	hideWindow(cmd)
	return cmd
}

// rel gives a path relative to the data folder, where the tools run.
func (a *App) rel(path string) string {
	if r, err := filepath.Rel(a.paths.Root, path); err == nil && !strings.HasPrefix(r, "..") {
		return r
	}
	return path
}

func threads() int {
	return max(2, min(8, runtime.NumCPU()-2))
}

var durationPattern = regexp.MustCompile(`Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)`)

// extractAudio converts the file's first audio track to 16 kHz mono WAV, the input whisper-cli reads.
func (a *App) extractAudio(ctx context.Context, job *Job, input string) (string, float64, error) {
	if _, err := os.Stat(input); err != nil {
		return "", 0, fmt.Errorf("Файл не найден: %s", filepath.Base(input))
	}
	total := 0.0
	probe, _ := a.command(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-i", input).CombinedOutput()
	if m := durationPattern.FindSubmatch(probe); m != nil {
		h, _ := strconv.ParseFloat(string(m[1]), 64)
		mins, _ := strconv.ParseFloat(string(m[2]), 64)
		s, _ := strconv.ParseFloat(string(m[3]), 64)
		total = h*3600 + mins*60 + s
	}
	out := filepath.Join(a.paths.Work, fmt.Sprintf("audio-%d.wav", job.ID))
	cmd := a.command(ctx, "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", input,
		"-map", "0:a:0", "-vn", "-sn", "-dn", "-af", "aresample=async=1:first_pts=0",
		"-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "-progress", "pipe:1", "-nostats", a.rel(out))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", 0, err
	}
	if err := cmd.Start(); err != nil {
		return "", 0, fmt.Errorf("Не удалось запустить ffmpeg: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		value, found := strings.CutPrefix(scanner.Text(), "out_time_us=")
		if us, err := strconv.ParseFloat(value, 64); found && err == nil && total > 0 {
			a.mu.Lock()
			job.Progress = math.Max(0, math.Min(1, us/1e6/total))
			a.publishJobLocked(false)
			a.mu.Unlock()
		}
	}
	io.Copy(io.Discard, stdout)
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return "", 0, ctx.Err()
		}
		message := strings.TrimSpace(stderr.String())
		if strings.Contains(message, "matches no streams") {
			return "", 0, errors.New("В файле нет звуковой дорожки")
		}
		return "", 0, fmt.Errorf("Не удалось прочитать звук из файла: %s", lastLine(message, err))
	}
	info, err := os.Stat(out)
	if err != nil || info.Size() < 44+3200 {
		return "", 0, errors.New("Звуковая дорожка пустая")
	}
	return out, float64(info.Size()-44) / 32000, nil
}

var (
	segmentPattern  = regexp.MustCompile(`^\[(\d+):(\d\d):(\d\d)[.,](\d{3}) --> (\d+):(\d\d):(\d\d)[.,](\d{3})\]\s*(.*)$`)
	progressPattern = regexp.MustCompile(`progress =\s*(\d+)%`)
)

// recognize runs whisper-cli with the settings of TransCore's WhisperEngine and takes phrases as they come.
func (a *App) recognize(ctx context.Context, job *Job, settings Settings, model ModelState) error {
	a.mu.Lock()
	job.Step, job.Progress = "model", -1
	a.publishJobLocked(true)
	a.mu.Unlock()
	language := settings.Language
	if language == "" {
		language = "auto"
	}
	beams := "5"
	if !settings.Accurate {
		beams = "1"
	}
	args := []string{"-m", a.rel(model.path), "-f", a.rel(job.wav), "-l", language, "-t", strconv.Itoa(threads()),
		"-bs", beams, "-sns", "-pp"}
	if prompt := strings.Join(strings.Fields(settings.Prompt), " "); prompt != "" {
		args = append(args, "--prompt", prompt, "--carry-initial-prompt")
	}
	if settings.SkipSilence {
		args = append(args, "--vad", "-vm", a.rel(filepath.Join(a.tools, vadModel)),
			"-vt", "0.5", "-vspd", "200", "-vsd", "300", "-vp", "200")
	}
	// whisper-cli reads its command line in the system code page, which would spoil a prompt in Russian: a response
	// file passes the arguments as UTF-8. Paths are relative to the data folder, so a Cyrillic user name does not matter.
	arguments := filepath.Join(a.paths.Work, "whisper-arguments.txt")
	if err := os.WriteFile(arguments, []byte(strings.Join(args, "\n")+"\n"), 0o644); err != nil {
		return err
	}
	cmd := a.command(ctx, "whisper-cli", "@"+a.rel(arguments))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Не удалось запустить Whisper: %w", err)
	}
	var log []string // the last lines of whisper's log, for an error message
	var reading sync.WaitGroup
	reading.Add(1)
	go func() {
		defer reading.Done()
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if log = append(log, line); len(log) > 40 {
				log = log[1:]
			}
			if m := progressPattern.FindStringSubmatch(line); m != nil {
				percent, _ := strconv.Atoi(m[1])
				a.mu.Lock()
				a.speechStartedLocked(job)
				job.Progress = math.Max(job.Progress, math.Min(0.99, float64(percent)/100))
				a.publishJobLocked(false)
				a.mu.Unlock()
			} else if strings.Contains(line, ": processing '") {
				a.mu.Lock()
				a.speechStartedLocked(job)
				a.mu.Unlock()
			}
		}
		io.Copy(io.Discard, stderr)
	}()
	filter := segmentFilter{}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		// A phrase may end inside a UTF-8 character; its broken bytes are dropped.
		m := segmentPattern.FindStringSubmatch(strings.ToValidUTF8(scanner.Text(), ""))
		if m == nil {
			continue
		}
		segment := Segment{Start: clockSeconds(m[1:5]), End: clockSeconds(m[5:9]), Text: strings.TrimSpace(m[9])}
		segment.End = math.Max(segment.Start, segment.End)
		if segment.Text == "" || !filter.accept(segment.Text) {
			continue
		}
		a.mu.Lock()
		a.speechStartedLocked(job)
		job.Segments = append(job.Segments, segment)
		job.SegmentCount = len(job.Segments)
		if job.Duration > 0 {
			job.Progress = math.Max(job.Progress, math.Min(0.99, segment.End/job.Duration))
		}
		a.hub.send("segment", map[string]any{"job": job.ID, "index": job.SegmentCount - 1, "segment": segment})
		a.publishJobLocked(false)
		a.mu.Unlock()
	}
	io.Copy(io.Discard, stdout)
	reading.Wait()
	err = cmd.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		text := strings.Join(log, "\n")
		if strings.Contains(text, "failed to load model") || strings.Contains(text, "failed to initialize whisper context") {
			return fmt.Errorf("Не удалось загрузить модель «%s». Возможно, файл повреждён: удалите модель и скачайте её заново", model.Name)
		}
		return fmt.Errorf("Ошибка распознавания: %s", lastLine(text, err))
	}
	return nil
}

func (a *App) speechStartedLocked(job *Job) {
	if job.Step == "speech" {
		return
	}
	job.Step, job.SpeechStarted = "speech", time.Now().UnixMilli()
	job.Progress = math.Max(0, job.Progress)
	a.publishJobLocked(true)
}

// clockSeconds reads "hh", "mm", "ss", "mmm" of a whisper-cli timestamp.
func clockSeconds(parts []string) float64 {
	var values [4]float64
	for i, part := range parts {
		values[i], _ = strconv.ParseFloat(part, 64)
	}
	return values[0]*3600 + values[1]*60 + values[2] + values[3]/1000
}

func lastLine(text string, err error) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if last := strings.TrimSpace(lines[len(lines)-1]); last != "" {
		return last
	}
	return err.Error()
}

var (
	hallucinations = []string{
		"dimatorzok", "dima torzok", "субтитры сделал", "субтитры делал", "субтитры создавал", "субтитры подготовил",
		"субтитры подогнал", "редактор субтитров", "корректор а.", "а.синецкая", "а. синецкая", "субтитры:",
		"amara.org", "subtitles by",
	}
	// Dropped only when they are the whole phrase: they can also be said for real.
	wholeHallucinations = map[string]bool{"продолжение следует": true, "продолжение следует...": true, "продолжение следует…": true}
)

// segmentFilter removes typical Whisper hallucinations (TransCore's SegmentFilter): credits of subtitle authors on
// silence, "[музыка]", a phrase repeated over and over.
type segmentFilter struct{ previous string }

func (f *segmentFilter) accept(text string) bool {
	t := strings.ToLower(strings.TrimSpace(text))
	for _, pattern := range hallucinations {
		if strings.Contains(t, pattern) {
			return false
		}
	}
	if wholeHallucinations[t] {
		return false
	}
	first, _ := utf8.DecodeRuneInString(t)
	last, _ := utf8.DecodeLastRuneInString(t)
	if (first == '[' && last == ']') || (first == '(' && last == ')') || (first == '*' && last == '*') {
		return false
	}
	if strings.IndexFunc(t, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }) < 0 {
		return false
	}
	// A long phrase right after itself is a decoding loop, not speech.
	if t == f.previous && len(strings.Fields(t)) >= 4 {
		return false
	}
	f.previous = t
	return true
}

// Hub sends events to the open pages (Server-Sent Events).
type Hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
	ever    bool
}

func newHub() *Hub { return &Hub{clients: map[chan []byte]struct{}{}} }

func (h *Hub) add() chan []byte {
	ch := make(chan []byte, 1024)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[ch] = struct{}{}
	h.ever = true
	return ch
}

func (h *Hub) remove(ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, ch)
}

func (h *Hub) count() (clients int, ever bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients), h.ever
}

// send delivers an event to every page. A page that falls behind is disconnected: it reconnects and reloads the state.
func (h *Hub) send(event string, data any) {
	payload, _ := json.Marshal(data)
	message := []byte("event: " + event + "\ndata: " + string(payload) + "\n\n")
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- message:
		default:
			delete(h.clients, ch)
			close(ch)
		}
	}
}
