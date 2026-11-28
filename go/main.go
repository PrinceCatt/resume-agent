// resume-agent API in Go: a drop-in for the Node server in server/ (same routes, database and data folder).
//
//	PORT      port to listen on (default 8791), always on 127.0.0.1
//	DATA_DIR  data folder (default <repo>/data), shared with the Node server
package main

import (
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/PrinceCatt/resume-agent/go/app"
)

// repoRoot finds the repository (the folder with fixtures/ and package.json) from the working
// directory or the executable, so `go run .` inside go/ and a built binary both work.
func repoRoot() string {
	if r := os.Getenv("RA_ROOT"); r != "" {
		abs, _ := filepath.Abs(r)
		return abs
	}
	starts := []string{}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	for _, s := range starts {
		for d := s; ; d = filepath.Dir(d) {
			if isRoot(d) {
				return d
			}
			if filepath.Dir(d) == d {
				break
			}
		}
	}
	wd, _ := os.Getwd()
	return wd
}

func isRoot(d string) bool {
	for _, f := range []string{"package.json", "fixtures", "go"} {
		if _, err := os.Stat(filepath.Join(d, f)); err != nil {
			return false
		}
	}
	return true
}

func main() {
	port := 8791
	if v := os.Getenv("PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			log.Fatalf("bad PORT %q", v)
		}
		port = n
	}
	app.Root = repoRoot()
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = filepath.Join(app.Root, "data")
	}
	if err := app.Init(dataDir); err != nil {
		log.Fatalf("database: %v", err)
	}
	handler := app.Handler()
	addr := "127.0.0.1:" + strconv.Itoa(port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	app.ServerURL = "http://" + addr
	suffix := ""
	if app.DistExists() {
		suffix = " (serving the built UI)"
	}
	log.Printf("resume-agent API (Go) on http://%s%s, data in %s", addr, suffix, app.DataDir)
	app.Background()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		app.Shutdown()
		os.Exit(0)
	}()
	srv := &http.Server{Handler: handler}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
