package main

import (
	"io/fs"
	"os"

	"github.com/cookrew/cookrew-app/phone/core/pair"
)

func stateFixture() pair.State {
	return pair.State{Registry: "http://127.0.0.1:1", Machines: map[string]pair.Machine{"m": {ID: "m", Token: "t"}}}
}

func statOf(file string) (fs.FileMode, error) {
	info, err := os.Stat(file)
	if err != nil {
		return 0, err
	}
	return info.Mode().Perm(), nil
}
