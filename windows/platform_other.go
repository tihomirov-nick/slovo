//go:build !windows

package main

// Stand-ins for running the page on a Mac during development.

import (
	"fmt"
	"os"
	"os/exec"
)

const exeSuffix = ""

func hideWindow(cmd *exec.Cmd) {}

func keepAwake() func() { return func() {} }

func openBrowserWindow(url, profile string) { exec.Command("open", url).Start() }

func focusWindow() {}

func openFolder(path string) { exec.Command("open", path).Start() }

func showError(message string) { fmt.Fprintln(os.Stderr, message) }
