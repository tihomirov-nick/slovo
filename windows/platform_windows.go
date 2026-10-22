//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

const exeSuffix = ".exe"

var (
	kernel32                    = syscall.NewLazyDLL("kernel32.dll")
	user32                      = syscall.NewLazyDLL("user32.dll")
	procSetThreadExecutionState = kernel32.NewProc("SetThreadExecutionState")
	procEnumWindows             = user32.NewProc("EnumWindows")
	procGetClassNameW           = user32.NewProc("GetClassNameW")
	procGetWindowTextW          = user32.NewProc("GetWindowTextW")
	procIsWindowVisible         = user32.NewProc("IsWindowVisible")
	procIsIconic                = user32.NewProc("IsIconic")
	procShowWindow              = user32.NewProc("ShowWindow")
	procSetForegroundWindow     = user32.NewProc("SetForegroundWindow")
	procMessageBoxW             = user32.NewProc("MessageBoxW")
)

// hideWindow keeps ffmpeg and whisper-cli from opening console windows.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

// keepAwake keeps the computer from sleeping until the returned function is called. The request belongs to a thread,
// so one OS thread holds it.
func keepAwake() func() {
	done := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		const continuous, systemRequired = 0x80000000, 0x00000001
		procSetThreadExecutionState.Call(continuous | systemRequired)
		<-done
		procSetThreadExecutionState.Call(continuous)
	}()
	return func() { close(done) }
}

// findBrowser gives Edge, which comes with Windows 10 and 11, or else Chrome.
func findBrowser() string {
	var candidates []string
	for _, relative := range []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`} {
		for _, variable := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
			if base := os.Getenv(variable); base != "" {
				candidates = append(candidates, filepath.Join(base, relative))
			}
		}
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// openBrowserWindow shows the page as an app window: no tabs or address bar, a profile of its own.
func openBrowserWindow(url, profile string) {
	if browser := findBrowser(); browser != "" {
		cmd := exec.Command(browser, "--app="+url, "--user-data-dir="+profile, "--window-size=560,740",
			"--no-first-run", "--no-default-browser-check", "--disable-background-mode", "--hide-crash-restore-bubble",
			"--disable-features=Translate")
		if cmd.Start() == nil {
			go cmd.Wait()
			return
		}
	}
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

// focusWindow brings Slovo's window forward. A launch the user has just made may do it, the running copy may not.
func focusWindow() {
	var found uintptr
	buffer := make([]uint16, 256)
	callback := syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
		if visible, _, _ := procIsWindowVisible.Call(hwnd); visible == 0 {
			return 1
		}
		procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if syscall.UTF16ToString(buffer) != "Chrome_WidgetWin_1" {
			return 1
		}
		n, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if title := syscall.UTF16ToString(buffer[:n]); title == "Slovo" || strings.HasSuffix(title, " · Slovo") {
			found = hwnd
			return 0
		}
		return 1
	})
	procEnumWindows.Call(callback, 0)
	if found == 0 {
		return
	}
	if minimized, _, _ := procIsIconic.Call(found); minimized != 0 {
		procShowWindow.Call(found, 9) // SW_RESTORE
	}
	procSetForegroundWindow.Call(found)
}

func openFolder(path string) {
	exec.Command("explorer", path).Start()
}

func showError(message string) {
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("Slovo")
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10) // MB_ICONERROR
}
