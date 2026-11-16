package main

import (
	"context"

	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

// MachinesScreen lists the account's machines; a machine the phone is on
// opens to its workspaces. Pulling down enters any machine added since.
func MachinesScreen(session *Session) ui.Node {
	nav := ui.UseNavigator()
	return ui.Column(ui.Style{Grow: 1},
		problem(session),
		ui.Show(signal.Func(func() bool { return session.Ending.Get() != "" }), func() ui.Node {
			return ui.Text(session.Ending, ui.Style{Font: fonts.Footnote, Color: colors.SecondaryLabel, Padding: ui.Symmetric(8, 20), Lines: 3})
		}),
		ui.List(ui.ListProps{OnRefresh: session.Refresh, Refreshing: session.Busy}, session.Machines,
			func(m MachineRow) string { return m.ID },
			func(m signal.Accessor[MachineRow], _ signal.Accessor[int]) ui.Node {
				return ui.View(ui.ViewProps{
					OnPress: func() {
						row := m.Get() // in a handler: not tracked
						if !row.Entered {
							return
						}
						nav.Push(func() ui.Node { return WorkspacesScreen(session, row.ID) }, ui.ScreenOptions{Title: ui.Val(row.Name)})
					},
					Style: ui.Style{Padding: ui.Symmetric(12, 20), Gap: 2},
				},
					ui.Text(signal.Func(func() string { return m.Get().Name }), ui.Style{Font: fonts.Body}),
					ui.Text(signal.Func(func() string { return machineLine(m.Get()) }), ui.Style{Font: fonts.Footnote, Color: colors.SecondaryLabel}),
				)
			}),
	)
}

// machineLine is a machine's standing in a few words.
func machineLine(m MachineRow) string {
	switch {
	case m.Note != "":
		return m.Note
	case !m.Online:
		return "Not connected"
	case m.Entered:
		return "Connected"
	}
	return "Joining…"
}

// WorkspacesScreen is one machine's workspaces, from its fleet.
func WorkspacesScreen(session *Session, machineID string) ui.Node {
	nav := ui.UseNavigator()
	fleet := signal.NewFunc(fleetSnapshot{}, never[fleetSnapshot])
	loading := signal.New(false)
	failed := signal.New("")
	load := func() {
		loading.Set(true)
		go func() {
			snapshot, err := readMachine(session, machineID)
			ui.Post(func() {
				loading.Set(false)
				if err != nil {
					failed.Set(err.Error())
					return
				}
				failed.Set("")
				fleet.Set(snapshot)
			})
		}()
	}
	load()
	workspaces := signal.Func(func() []fleetWorkspace { return fleet.Get().Workspaces })
	return ui.Column(ui.Style{Grow: 1},
		ui.Show(signal.Func(func() bool { return failed.Get() != "" }), func() ui.Node {
			return ui.Text(failed, ui.Style{Font: fonts.Footnote, Color: colors.Red, Padding: ui.All(16)})
		}),
		ui.List(ui.ListProps{OnRefresh: load, Refreshing: loading}, workspaces,
			func(w fleetWorkspace) string { return w.ID },
			func(w signal.Accessor[fleetWorkspace], _ signal.Accessor[int]) ui.Node {
				return ui.View(ui.ViewProps{
					OnPress: func() {
						space := w.Get()
						nav.Push(func() ui.Node { return AgentsScreen(space) }, ui.ScreenOptions{Title: ui.Val(space.Name)})
					},
					Style: ui.Style{Padding: ui.Symmetric(12, 20), Gap: 2},
				},
					ui.Text(signal.Func(func() string { return w.Get().Name }), ui.Style{Font: fonts.Body}),
					ui.Text(signal.Func(func() string { return agentCount(w.Get()) }), ui.Style{Font: fonts.Footnote, Color: colors.SecondaryLabel}),
				)
			}),
	)
}

// readMachine is one fleet snapshot of a machine, down the relay. Off the main thread.
func readMachine(session *Session, machineID string) (fleetSnapshot, error) {
	road, err := session.Road(machineID)
	if err != nil {
		return fleetSnapshot{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), netTimeout)
	defer cancel()
	return readFleet(ctx, road)
}

// AgentsScreen is one workspace's agents as the snapshot had them.
func AgentsScreen(space fleetWorkspace) ui.Node {
	return ui.List(ui.ListProps{}, ui.Val(space.Agents),
		func(a fleetAgent) string { return a.ID },
		func(a signal.Accessor[fleetAgent], _ signal.Accessor[int]) ui.Node {
			return ui.Column(ui.Style{Padding: ui.Symmetric(12, 20), Gap: 2},
				ui.Text(signal.Func(func() string { return a.Get().Name }), ui.Style{Font: fonts.Body}),
				ui.Text(signal.Func(func() string { return agentLine(a.Get()) }), ui.Style{Font: fonts.Footnote, Color: colors.SecondaryLabel, Lines: 2}),
			)
		})
}
