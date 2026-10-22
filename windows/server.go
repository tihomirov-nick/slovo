package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

//go:embed web
var webFiles embed.FS

// Content types are set here: Go takes them from the Windows registry, where .js is sometimes text/plain.
var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
	".png": "image/png", ".svg": "image/svg+xml",
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", a.serveFile)
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, a.state()) })
	mux.HandleFunc("GET /api/events", a.serveEvents)
	mux.HandleFunc("POST /api/upload", a.handleUpload)
	mux.HandleFunc("POST /api/activate", a.handleActivate)
	mux.HandleFunc("POST /api/open", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Path string }
		if decode(w, r, &req) {
			reply(w, a.start(startRequest{input: req.Path, name: filepath.Base(req.Path)}))
		}
	})
	mux.HandleFunc("POST /api/rerun", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Model, Language string }
		if decode(w, r, &req) {
			reply(w, a.start(startRequest{model: req.Model, lang: req.Language}))
		}
	})
	mux.HandleFunc("POST /api/cancel", func(w http.ResponseWriter, r *http.Request) { a.cancelJob(); reply(w, nil) })
	mux.HandleFunc("POST /api/reset", func(w http.ResponseWriter, r *http.Request) { a.reset(); reply(w, nil) })
	mux.HandleFunc("POST /api/settings", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err == nil {
			err = a.updateSettings(body)
		}
		reply(w, err)
	})
	mux.HandleFunc("POST /api/models/{action}", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ ID string }
		if !decode(w, r, &req) {
			return
		}
		switch r.PathValue("action") {
		case "download":
			reply(w, a.downloadModel(req.ID))
		case "cancel":
			a.cancelDownload(req.ID)
			reply(w, nil)
		case "delete":
			reply(w, a.deleteModel(req.ID))
		case "folder":
			openFolder(a.paths.Models)
			reply(w, nil)
		default:
			http.NotFound(w, r)
		}
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only Slovo's own page: another site cannot send the token header without the page's consent (CORS), and a
		// foreign host name means DNS rebinding.
		if r.Host != a.host || (r.Method != http.MethodGet && r.Header.Get("X-Slovo-Token") != a.token) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *App) serveFile(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	data, err := webFiles.ReadFile("web/" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if name == "index.html" {
		data = bytes.Replace(data, []byte("{{token}}"), []byte(a.token), 1)
	}
	w.Header().Set("Content-Type", contentTypes[path.Ext(name)])
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

func (a *App) serveEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	events := a.hub.add()
	defer a.hub.remove(events)
	fmt.Fprint(w, "retry: 1000\n\n")
	flusher.Flush()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case message, open := <-events:
			if !open {
				return
			}
			w.Write(message)
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
		case <-r.Context().Done():
			return
		}
		flusher.Flush()
	}
}

// handleUpload takes a file dropped into the window: the page cannot tell its path, so it sends the file itself.
func (a *App) handleUpload(w http.ResponseWriter, r *http.Request) {
	if a.busy() {
		replyStatus(w, errBusy, http.StatusConflict)
		return
	}
	name := filepath.Base(r.URL.Query().Get("name"))
	extension := strings.ToLower(filepath.Ext(name))
	if len(extension) > 12 || strings.ContainsAny(extension, `\/:*?"<>|`) {
		extension = ""
	}
	target := filepath.Join(a.paths.Work, fmt.Sprintf("upload-%d%s", time.Now().UnixNano(), extension))
	f, err := os.Create(target)
	if err == nil {
		_, err = io.Copy(f, r.Body)
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
	}
	if err != nil {
		os.Remove(target)
		replyStatus(w, fmt.Errorf("Не удалось прочитать файл: %w", err), http.StatusInternalServerError)
		return
	}
	reply(w, a.start(startRequest{input: target, upload: true, name: name}))
}

// handleActivate answers a second launch of Slovo: it may bring a file, and the window opens again if it was closed.
func (a *App) handleActivate(w http.ResponseWriter, r *http.Request) {
	var req struct{ Path string }
	if !decode(w, r, &req) {
		return
	}
	clients, _ := a.hub.count()
	if req.Path != "" {
		a.start(startRequest{input: req.Path, name: filepath.Base(req.Path)})
	}
	if clients == 0 && a.openWindow != nil {
		a.openWindow()
	}
	writeJSON(w, map[string]bool{"window": clients > 0})
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		replyStatus(w, err, http.StatusBadRequest)
		return false
	}
	return true
}

func reply(w http.ResponseWriter, err error) {
	replyStatus(w, err, http.StatusConflict)
}

func replyStatus(w http.ResponseWriter, err error, status int) {
	if err == nil {
		writeJSON(w, map[string]bool{"ok": true})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
