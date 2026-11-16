module github.com/cookrew/cookrew-app/phone/app

go 1.26.0

require (
	github.com/cookrew/cookrew-app/phone v0.0.0
	github.com/egoist/asuka v0.1.1
)

require (
	github.com/ebitengine/purego v0.11.2 // indirect
	golang.org/x/text v0.43.0 // indirect
)

// The client's core (phone/core) is in this repository, not published:
// build against the copy beside this one, as desktop/ does.
replace github.com/cookrew/cookrew-app/phone => ../
