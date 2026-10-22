// Slovo for Windows transcribes audio and video into text with Whisper on the computer itself, without internet.
// The window is a local page that Microsoft Edge shows as an app; this program serves it and runs ffmpeg and
// whisper-cli, which the build packs inside the exe.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

var version = "dev"

//go:embed payload
var payload embed.FS

// preferredPort keeps the page's address the same between launches; another port is taken when it is busy.
const preferredPort = 47913

// Paths of the data folder: %LOCALAPPDATA%\Slovo.
type Paths struct {
	Root   string
	Models string
	Work   string
}

type instanceInfo struct {
	Address string `json:"address"`
	Token   string `json:"token"`
}

func main() {
	noWindow := flag.Bool("no-window", false, "serve the page without opening a window (tests)")
	flag.Parse()
	paths, err := setupPaths()
	if err != nil {
		fail(err)
	}
	file := ""
	if flag.NArg() > 0 {
		file, _ = filepath.Abs(flag.Arg(0))
	}
	// A file dropped on the icon or opened with Slovo while it runs goes to the running copy.
	if activateRunning(paths, file) {
		return
	}
	tools, err := prepareTools(paths)
	if err != nil {
		fail(err)
	}
	app := newApp(paths, tools)
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferredPort))
	if err != nil {
		if listener, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
			fail(err)
		}
	}
	app.host = listener.Addr().String()
	instance := filepath.Join(paths.Root, "instance.json")
	data, _ := json.Marshal(instanceInfo{Address: app.host, Token: app.token})
	if err := os.WriteFile(instance, data, 0o600); err != nil {
		fail(err)
	}
	go http.Serve(listener, app.routes())
	if file != "" {
		app.start(startRequest{input: file, name: filepath.Base(file)})
	}
	if *noWindow {
		select {}
	}
	url := "http://" + app.host + "/"
	app.openWindow = func() { openBrowserWindow(url, filepath.Join(paths.Root, "browser")) }
	app.openWindow()
	app.waitUntilClosed()
	app.shutdown()
	os.Remove(instance)
}

func fail(err error) {
	showError("Slovo не запустился: " + err.Error())
	os.Exit(1)
}

func setupPaths() (Paths, error) {
	root := os.Getenv("SLOVO_HOME")
	if root == "" {
		base, err := os.UserCacheDir() // %LOCALAPPDATA% on Windows
		if err != nil {
			return Paths{}, err
		}
		root = filepath.Join(base, "Slovo")
	}
	p := Paths{Root: root, Models: filepath.Join(root, "Models"), Work: filepath.Join(root, "work")}
	for _, dir := range []string{p.Models, p.Work} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return p, err
		}
	}
	return p, nil
}

// activateRunning hands the file to a running copy and brings its window forward. False when none runs.
func activateRunning(paths Paths, file string) bool {
	data, err := os.ReadFile(filepath.Join(paths.Root, "instance.json"))
	var info instanceInfo
	if err != nil || json.Unmarshal(data, &info) != nil || info.Address == "" {
		return false
	}
	body, _ := json.Marshal(map[string]string{"path": file})
	req, err := http.NewRequest(http.MethodPost, "http://"+info.Address+"/api/activate", bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("X-Slovo-Token", info.Token)
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var result struct{ Window bool }
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&result) != nil {
		return false
	}
	if result.Window {
		focusWindow()
	}
	return true
}

// prepareTools unpacks ffmpeg and whisper-cli from the exe once per build, into the data folder.
// SLOVO_BIN_DIR points at the tools instead (development on a Mac).
func prepareTools(paths Paths) (string, error) {
	if dir := os.Getenv("SLOVO_BIN_DIR"); dir != "" {
		return dir, nil
	}
	data, err := payload.ReadFile("payload/bin.zip")
	if err != nil {
		return "", errors.New("в эту сборку не вложены ffmpeg и Whisper")
	}
	sum := sha256.Sum256(data)
	parent := filepath.Join(paths.Root, "bin")
	dir := filepath.Join(parent, hex.EncodeToString(sum[:6]))
	if _, err := os.Stat(filepath.Join(dir, ".ready")); err == nil {
		return dir, nil
	}
	// Tools of earlier builds are not needed any more.
	os.RemoveAll(parent)
	temporary := dir + ".tmp"
	if err := os.MkdirAll(temporary, 0o755); err != nil {
		return "", err
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	for _, file := range archive.File {
		if file.FileInfo().IsDir() {
			continue
		}
		if err := unpack(file, filepath.Join(temporary, filepath.Base(file.Name))); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(filepath.Join(temporary, ".ready"), nil, 0o644); err != nil {
		return "", err
	}
	return dir, os.Rename(temporary, dir)
}

func unpack(file *zip.File, target string) error {
	in, err := file.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func randomToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
