package main

import (
	"fmt"
	"log"
	"os"
	ossignal "os/signal"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/cookrew/cookrew-app/desktop/snap"
	"github.com/egoist/asuka/ui"
)

// QA hooks, for screenshots and measurements without a mouse. All are off
// unless their variable is set:
//
//	COOKREW_NATIVE_WORKSPACE=<id>  start on this workspace
//	COOKREW_NATIVE_AGENT=<id>      open this agent's terminal at start
//	COOKREW_NATIVE_QA_DIR=<dir>    SIGUSR1 writes the window to <dir>/shot-NN.png
//	                               and SIGHUP scrolls the wheel 5 lines down over
//	                               the open terminal (a real AppKit wheel event;
//	                               AppKit delivers it only while unlocked)
//	COOKREW_NATIVE_KEYS=<text>     with the QA dir, SIGUSR2 types <text> (Go
//	                               escapes: \r is Return) into the open terminal

func qaWorkspace() string { return os.Getenv("COOKREW_NATIVE_WORKSPACE") }

// qaAgentOnce is COOKREW_NATIVE_AGENT the first time it is asked, then "":
// the agent opens at start, not each time its workspace is shown.
func qaAgentOnce() string {
	if qaAgentAsked.Swap(true) {
		return ""
	}
	return os.Getenv("COOKREW_NATIVE_AGENT")
}

var qaAgentAsked atomic.Bool

// startQA listens for SIGUSR1 when COOKREW_NATIVE_QA_DIR names a folder, once.
var startQA = sync.OnceFunc(listenQA)

func listenQA() {
	dir := os.Getenv("COOKREW_NATIVE_QA_DIR")
	if dir == "" {
		return
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		log.Printf("qa: %s is not a folder; no screenshots", dir)
		return
	}
	pictures, err := snap.NewSnap()
	if err != nil {
		log.Printf("qa: no screenshots: %v", err)
		return
	}
	keys, err := strconv.Unquote(`"` + os.Getenv("COOKREW_NATIVE_KEYS") + `"`)
	if err != nil {
		log.Printf("qa: COOKREW_NATIVE_KEYS: %v", err)
		keys = ""
	}
	asked := make(chan os.Signal, 2)
	ossignal.Notify(asked, syscall.SIGUSR1, syscall.SIGUSR2, syscall.SIGHUP)
	go func() {
		n := 0
		for sig := range asked {
			if sig == syscall.SIGHUP {
				ui.Post(func() { report("wheel", pictures.Wheel(-5)) })
				continue
			}
			if sig == syscall.SIGUSR2 {
				if keys != "" {
					ui.Post(func() { report("keys", pictures.Keys(keys)) })
				}
				continue
			}
			n++
			path := filepath.Join(dir, fmt.Sprintf("shot-%02d.png", n))
			ui.Post(func() { report(path, pictures.Window(path)) })
		}
	}()
}

func report(what string, err error) {
	if err != nil {
		log.Printf("qa: %s: %v", what, err)
	}
}
