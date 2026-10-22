// Command pack writes payload/bin.zip, the tools Slovo.exe unpacks on its first launch:
//
//	pack <out.zip> <file | archive.zip!pattern>...
//
// A pattern takes the archive's entries whose names match it (path.Match on the base name).
package main

import (
	"archive/zip"
	"compress/flate"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) < 3 {
		fail(fmt.Errorf("usage: pack <out.zip> <file | archive.zip!pattern>..."))
	}
	out, err := os.Create(os.Args[1])
	if err != nil {
		fail(err)
	}
	w := zip.NewWriter(out)
	w.RegisterCompressor(zip.Deflate, func(out io.Writer) (io.WriteCloser, error) {
		return flate.NewWriter(out, flate.BestCompression)
	})
	for _, source := range os.Args[2:] {
		if archive, pattern, found := strings.Cut(source, "!"); found {
			err = addFromArchive(w, archive, pattern)
		} else {
			err = addFile(w, source)
		}
		if err != nil {
			fail(err)
		}
	}
	if err := w.Close(); err != nil {
		fail(err)
	}
	if err := out.Close(); err != nil {
		fail(err)
	}
}

func addFile(w *zip.Writer, name string) error {
	in, err := os.Open(name)
	if err != nil {
		return err
	}
	defer in.Close()
	return add(w, filepath.Base(name), in)
}

func addFromArchive(w *zip.Writer, archive, pattern string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	matched := 0
	for _, file := range r.File {
		if ok, _ := path.Match(pattern, path.Base(file.Name)); !ok || file.FileInfo().IsDir() {
			continue
		}
		in, err := file.Open()
		if err != nil {
			return err
		}
		err = add(w, path.Base(file.Name), in)
		in.Close()
		if err != nil {
			return err
		}
		matched++
	}
	if matched == 0 {
		return fmt.Errorf("%s: nothing matches %s", archive, pattern)
	}
	return nil
}

func add(w *zip.Writer, name string, in io.Reader) error {
	out, err := w.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	fmt.Println("  " + name)
	return err
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "pack:", err)
	os.Exit(1)
}
