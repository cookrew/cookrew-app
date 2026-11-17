// Package core_test holds the rule every package under core/ keeps: no UI
// framework. The client's logic must outlive the framework it is drawn with.
package core_test

import (
	"os/exec"
	"strings"
	"testing"
)

// forbidden are module paths core/ may never depend on.
var forbidden = []string{"github.com/egoist/asuka"}

func TestCoreImportsNoUIFramework(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", "./...").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		for _, banned := range forbidden {
			if strings.HasPrefix(dep, banned) {
				t.Errorf("core/ depends on %s", dep)
			}
		}
	}
}
