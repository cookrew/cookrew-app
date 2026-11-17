package main

import (
	"slices"
	"strconv"

	"github.com/egoist/asuka/colors"
	"github.com/egoist/asuka/fonts"
	"github.com/egoist/asuka/signal"
	"github.com/egoist/asuka/ui"
)

// Root is the window: the machine's workspaces in the native sidebar, the
// chosen one's agents beside it.
func Root(store *Store) ui.Node {
	ids := store.WorkspaceIDs()
	selected := signal.New(0)
	// The workspace the user is on, by id: an index would move to another
	// workspace when one before it comes or goes.
	chosen := ""
	signal.Effect(func() {
		i := selected.Get()
		if list := signal.Untrack(ids.Get); i >= 0 && i < len(list) {
			chosen = list[i]
		}
	})
	return ui.Show(store.Loaded, func() ui.Node {
		// Rebuilt only when a workspace comes or goes; names and badges follow on their own.
		return ui.Dynamic(func() ui.Node {
			list := ids.Get()
			if len(list) == 0 {
				return notice("This Mac has no workspaces yet.")
			}
			selected.Set(pickWorkspace(list, chosen, store.Fleet.Peek().FocusedWorkspaceID))
			return ui.SplitView(ui.SplitViewProps{
				Title:    signal.Func(func() string { return store.Fleet.Get().Machine.Name }),
				Selected: selected,
				Sections: []ui.SidebarSection{{Title: ui.Val("Workspaces"), Destinations: destinations(store, list)}},
			})
		})
	}, func() ui.Node { return Waiting(store) })
}

// pickWorkspace is the index to show: the chosen workspace if it is still
// there, else the QA one, else the one the desktop shows, else the first.
func pickWorkspace(list []string, chosen, focused string) int {
	for _, want := range []string{chosen, qaWorkspace(), focused} {
		if i := slices.Index(list, want); want != "" && i >= 0 {
			return i
		}
	}
	return 0
}

func destinations(store *Store, ids []string) []ui.Destination {
	out := make([]ui.Destination, 0, len(ids))
	for _, id := range ids {
		workspace := store.Workspace(id)
		out = append(out, ui.Destination{
			Title: signal.Func(func() string { return workspace.Get().Name }),
			Icon:  "square.grid.2x2",
			// What needs the owner: the agents waiting on an answer.
			Badge: signal.Func(func() string {
				n := 0
				for _, a := range workspace.Get().Agents {
					if a.Phase == "waiting" {
						n++
					}
				}
				if n == 0 {
					return ""
				}
				return strconv.Itoa(n)
			}),
			Content: func() ui.Node { return AgentsScreen(store, id) },
		})
	}
	return out
}

// Waiting is the window before the first snapshot: why it is not there yet.
func Waiting(store *Store) ui.Node {
	return ui.Column(ui.Style{Grow: 1, Justify: ui.JustifyCenter, Align: ui.AlignCenter, Gap: 10, Padding: ui.All(24)},
		ui.Symbol("antenna.radiowaves.left.and.right", ui.Style{Color: colors.SecondaryLabel}),
		ui.StaticText("Connecting to Cookrew on this Mac", ui.Style{Font: fonts.Headline}),
		ui.Text(store.Link, ui.Style{Font: fonts.Footnote, Color: colors.SecondaryLabel, TextAlign: ui.TextCenter, Lines: 3}),
	)
}
