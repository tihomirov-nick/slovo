package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ModelInfo is a Whisper model in ggml format that can be downloaded in the app (TransCore's ModelCatalog).
type ModelInfo struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Details      string `json:"details"`
	File         string `json:"file"`
	URL          string `json:"-"`
	Size         int64  `json:"size"`
	SHA256       string `json:"-"`
	Recommended  bool   `json:"recommended,omitempty"`
	RussianTuned bool   `json:"russianTuned,omitempty"`
}

const whisperCpp = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"

var catalog = []ModelInfo{
	{ID: "large-v3-turbo-q8_0", Name: "Whisper Large v3 Turbo",
		Details: "Быстрая и точная, понимает русский и ещё около 100 языков. Подходит для большинства записей",
		File:    "ggml-large-v3-turbo-q8_0.bin", URL: whisperCpp + "ggml-large-v3-turbo-q8_0.bin",
		Size: 874_188_075, SHA256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1", Recommended: true},
	{ID: "large-v3-turbo-q5_0", Name: "Whisper Large v3 Turbo (лёгкая)",
		Details: "Сжатая версия Turbo. Качество почти то же, а файл меньше",
		File:    "ggml-large-v3-turbo-q5_0.bin", URL: whisperCpp + "ggml-large-v3-turbo-q5_0.bin",
		Size: 574_041_195, SHA256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"},
	{ID: "large-v3-russian-q5_0", Name: "Whisper Large v3 Russian",
		Details: "Дообучена на русской речи (antony66) и реже ошибается в словах. Работает примерно в 3 раза медленнее Turbo",
		File:    "ggml-large-v3-russian-q5_0.bin",
		URL:     "https://huggingface.co/Pomni/whisper-large-v3-russian-ggml-allquants/resolve/main/ggml-large-v3-russian-q5_0.bin",
		Size:    1_081_140_203, SHA256: "21444001e24953d2d4da409f4ef6a7f22daf961cbb6f453eb7fbb1cd63337798", RussianTuned: true},
	{ID: "large-v3-russian-podlodka-q5_0", Name: "Whisper Large v3 Russian Podlodka",
		Details: "Дообучена на русских подкастах, подходит для интервью, встреч и другой живой речи. Работает примерно в 3 раза медленнее Turbo",
		File:    "ggml-large-v3-russian-ties-podlodka-v1.2-q5_0.bin",
		URL:     "https://huggingface.co/Pomni/whisper-large-v3-russian-ties-podlodka-v1.2-ggml-allquants/resolve/main/ggml-large-v3-russian-ties-podlodka-v1.2-q5_0.bin",
		Size:    1_081_140_203, SHA256: "1ba1effb19430fcdb02c287c41f1a08acd79563e20eb8361185ea1c1f97b2fe3", RussianTuned: true},
	{ID: "large-v3-q5_0", Name: "Whisper Large v3",
		Details: "Самая точная из стандартных моделей Whisper, но медленная",
		File:    "ggml-large-v3-q5_0.bin", URL: whisperCpp + "ggml-large-v3-q5_0.bin",
		Size: 1_081_140_203, SHA256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1"},
	{ID: "medium-q5_0", Name: "Whisper Medium",
		Details: "Модель среднего размера для слабых или старых компьютеров",
		File:    "ggml-medium-q5_0.bin", URL: whisperCpp + "ggml-medium-q5_0.bin",
		Size: 539_212_467, SHA256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f"},
	{ID: "small", Name: "Whisper Small", Details: "Быстрая, но ошибается заметно чаще",
		File: "ggml-small.bin", URL: whisperCpp + "ggml-small.bin",
		Size: 487_601_967, SHA256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"},
	{ID: "base", Name: "Whisper Base", Details: "Очень быстрая, годится для черновика",
		File: "ggml-base.bin", URL: whisperCpp + "ggml-base.bin",
		Size: 147_951_465, SHA256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"},
}

// preferredOrder is the default among installed models: standard Whisper Turbo first, then the catalog in order.
var preferredOrder = []string{"large-v3-turbo-q8_0", "large-v3-turbo-q5_0", "large-v3-q5_0"}

type ModelState struct {
	ModelInfo
	Custom      bool   `json:"custom,omitempty"`
	Downloaded  bool   `json:"downloaded"`
	Downloading bool   `json:"downloading,omitempty"`
	Verifying   bool   `json:"verifying,omitempty"`
	Received    int64  `json:"received,omitempty"`
	Error       string `json:"error,omitempty"`
	path        string
}

type download struct {
	cancel    context.CancelFunc
	received  int64
	verifying bool
}

func catalogModel(id string) (ModelInfo, bool) {
	for _, m := range catalog {
		if m.ID == id {
			return m, true
		}
	}
	return ModelInfo{}, false
}

// modelStatesLocked lists the catalog and the model files the user put into the folder.
func (a *App) modelStatesLocked() []ModelState {
	var states []ModelState
	known := map[string]bool{}
	for _, m := range catalog {
		known[strings.ToLower(m.File)] = true
		s := ModelState{ModelInfo: m, path: filepath.Join(a.paths.Models, m.File), Error: a.failures[m.ID]}
		if info, err := os.Stat(s.path); err == nil && info.Size() == m.Size {
			s.Downloaded = true
		}
		if d := a.downloads[m.ID]; d != nil {
			s.Downloading, s.Received, s.Verifying = true, d.received, d.verifying
		}
		states = append(states, s)
	}
	entries, _ := os.ReadDir(a.paths.Models)
	for _, entry := range entries {
		name := entry.Name()
		lower := strings.ToLower(name)
		if entry.IsDir() || known[lower] || filepath.Ext(lower) != ".bin" || strings.HasPrefix(name, ".") || strings.Contains(lower, "silero") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		states = append(states, ModelState{
			ModelInfo: ModelInfo{ID: "file:" + name, Name: strings.TrimSuffix(name, filepath.Ext(name)), File: name, Size: info.Size()},
			Custom:    true, Downloaded: true, path: filepath.Join(a.paths.Models, name),
		})
	}
	return states
}

// pickModelLocked gives the chosen model if it is downloaded, otherwise the default among the downloaded ones.
func (a *App) pickModelLocked(id string) (ModelState, bool) {
	states := a.modelStatesLocked()
	downloaded := map[string]ModelState{}
	for _, s := range states {
		if s.Downloaded {
			downloaded[s.ID] = s
		}
	}
	if s, ok := downloaded[id]; ok {
		return s, true
	}
	for _, preferred := range preferredOrder {
		if s, ok := downloaded[preferred]; ok {
			return s, true
		}
	}
	for _, s := range states {
		if s.Downloaded {
			return s, true
		}
	}
	return ModelState{}, false
}

func (a *App) publishModelsLocked(force bool) {
	if !force && time.Since(a.lastModelsEvent) < 250*time.Millisecond {
		return
	}
	a.lastModelsEvent = time.Now()
	a.hub.send("models", a.modelStatesLocked())
}

func (a *App) downloadModel(id string) error {
	info, ok := catalogModel(id)
	if !ok {
		return errors.New("Такой модели нет в каталоге")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.downloads[id] != nil {
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &download{cancel: cancel}
	a.downloads[id] = d
	delete(a.failures, id)
	a.publishModelsLocked(true)
	go func() {
		err := fetchModel(ctx, info, a.paths.Models, func(received int64, verifying bool) {
			a.mu.Lock()
			d.received, d.verifying = received, verifying
			a.publishModelsLocked(false)
			a.mu.Unlock()
		})
		a.mu.Lock()
		defer a.mu.Unlock()
		delete(a.downloads, id)
		if err != nil && ctx.Err() == nil {
			a.failures[id] = err.Error()
		}
		a.publishModelsLocked(true)
	}()
	return nil
}

func (a *App) cancelDownload(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if d := a.downloads[id]; d != nil {
		d.cancel()
	}
}

func (a *App) deleteModel(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, s := range a.modelStatesLocked() {
		if s.ID != id || !s.Downloaded {
			continue
		}
		if a.job != nil && a.job.Status == "working" && a.job.ModelName == s.Name {
			return errors.New("Эта модель сейчас распознаёт файл")
		}
		if err := os.Remove(s.path); err != nil {
			return err
		}
		os.Remove(s.path + ".part")
		a.publishModelsLocked(true)
	}
	return nil
}

// fetchModel downloads a model into a .part file, resuming after a broken connection, and checks its SHA-256.
func fetchModel(ctx context.Context, m ModelInfo, dir string, progress func(received int64, verifying bool)) error {
	final := filepath.Join(dir, m.File)
	part := final + ".part"
	for attempt := 1; ; attempt++ {
		err := fetchPart(ctx, m, part, progress)
		if err == nil {
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if attempt == 6 {
			return fmt.Errorf("Не удалось скачать модель: %v", err)
		}
		select {
		case <-time.After(time.Duration(attempt) * 3 * time.Second):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	progress(m.Size, true)
	sum, err := fileSHA256(part)
	if err != nil {
		return err
	}
	if sum != m.SHA256 {
		os.Remove(part)
		return errors.New("Модель скачалась с ошибкой, попробуйте ещё раз")
	}
	return os.Rename(part, final)
}

func fetchPart(ctx context.Context, m ModelInfo, part string, progress func(int64, bool)) error {
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	offset, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	if offset == m.Size {
		return nil
	}
	if offset > m.Size {
		if err := f.Truncate(0); err != nil {
			return err
		}
		offset, _ = f.Seek(0, io.SeekStart)
	}
	// A connection that sends nothing for a minute is dropped and resumed.
	attempt, cancel := context.WithCancel(ctx)
	defer cancel()
	watchdog := time.AfterFunc(time.Minute, cancel)
	defer watchdog.Stop()
	req, err := http.NewRequestWithContext(attempt, http.MethodGet, m.URL, nil)
	if err != nil {
		return err
	}
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusPartialContent:
	case http.StatusOK:
		if err := f.Truncate(0); err != nil {
			return err
		}
		if offset, err = f.Seek(0, io.SeekStart); err != nil {
			return err
		}
	default:
		return fmt.Errorf("сервер ответил %s", resp.Status)
	}
	buffer := make([]byte, 1<<20)
	reported := time.Now()
	for {
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			if _, err := f.Write(buffer[:n]); err != nil {
				return err
			}
			offset += int64(n)
			watchdog.Reset(time.Minute)
			if time.Since(reported) > 200*time.Millisecond {
				progress(offset, false)
				reported = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	progress(offset, false)
	if offset != m.Size {
		return fmt.Errorf("скачано %d байт из %d", offset, m.Size)
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
