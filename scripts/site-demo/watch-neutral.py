# The watch-shots fixture, recast for the site: the demo cast instead of the maintainer's workspaces and crew.
# Edits only a copy of the watch package; the repository's watch/ is not touched.
import sys

# usage: python3 -I scripts/site-demo/watch-neutral.py <a COPY of watch/>/Sources/watch-shots/Shots.swift
path = sys.argv[1]
src = open(path, encoding='utf8').read()
pairs = [
    ('"Allow this edit to src/main/watch-routes.ts?", sub: "Edit · +12 −3"', '"Allow this edit to CHANGELOG.md?", sub: "Edit · CHANGELOG.md · +18 −0"'),
    ('"Yes, and allow all edits this session"', '"Yes, allow all edits during this session"'),
    ('"No, tell Claude what to do differently"', '"No, and tell Claude what to do differently"'),
    ('"Which card should the watch open on?"', '"Which install path should the guide lead with?"'),
    ('WaitOption(key: "1", label: "The one that needs me", detail: "needs-you first")', 'WaitOption(key: "1", label: "The download button", detail: "Mac app first")'),
    ('WaitOption(key: "2", label: "The last one I read")', 'WaitOption(key: "2", label: "Homebrew", detail: "one command")'),
    ('name: "Cookrew Dev", active: true', 'name: "Release Room", active: true'),
    ('name: "GOAT Team", active: false', 'name: "Docs Site", active: false'),
    ('"Text selection on the phone works now: hold, then drag. It\'s merged into dev and the app is restarted.\\n\\n**Why it didn\'t work before:** the phone sends touch to the card\'s Chrome, and headless Chrome never turns a touch into a text selection."',
     '"All 12 links on the release notes page resolve, and the page renders at 390 px without overflow.\\n\\nOne image is missing its alt text; I listed it in release-checklist."'),
    ('name: "Atlas", preset: "Claude Code", orch: true', 'name: "Planner", preset: "Claude Code", orch: true'),
    ('name: "交互优化", preset: "Claude Code"', 'name: "Checker", preset: "OpenCode"'),
    ('"Text selection on the phone works now."', '"All 12 links on the release notes page resolve."'),
    ('name: "Fresco", preset: "Codex"', 'name: "Reviewer", preset: "Codex"'),
    ('"Make the watch card match the phone\'s type scale"', '"Review the v1.4 API diff"'),
    ('name: "Gauge", preset: "Claude Code"', 'name: "Notes", preset: "Pi"'),
    ('"All 109 checks pass at 412, 375 and 1440."', '"Three themes: faster sign-in, clearer errors, an export button."'),
    ('name: "Velvet", preset: "Pi"', 'name: "Editor", preset: "Codex"'),
    ('"The motion brief is in the note."', '"The FAQ reads cleanly; two anchors fixed."'),
    ('name: "Tinker", preset: "OpenCode"', 'name: "Writer", preset: "Claude Code"'),
    ('"Should I push the release branch, or wait for the signing keys?"', '"Should the guide show the v1.4 screenshots, or wait for the final build?"'),
    ('name: "Which", preset: "Claude Code"', 'name: "Guide", preset: "Claude Code"'),
    ('"Yes, merge it and tell me when it\'s live"', '"Thanks. Add the alt text too"'),
    ('"Fix the flaky build"', '"Summarise the customer notes"'),
    ('title: "Browser cards", host: "file://docs"', 'title: "Release notes", host: "docs.example.com"'),
    ('title: "Cookrew logo", host: "127.0.0.1:5311"', 'title: "Upgrade guide", host: "docs.example.com"'),
    ('title: "plan", host: "note"', 'title: "release-checklist", host: "note"'),
    ('Text("Browser cards: drawn directly")', 'Text("Release notes · v1.4")'),
    ('Text("Hold on a word, then drag to select it. Tap ⧉ to copy.")', 'Text("Export a report as CSV from any table.")'),
    ('NoteBody(name: "plan", content: "**Watch baseline**\\n\\nCards first, then the box.\\nCrown walks the cards.")', 'NoteBody(name: "release-checklist", content: "**release-checklist**\\n\\nChangelog drafted.\\nAPI diff reviewed.")'),
    ('DeviceRow(id: "m1", name: "MacBook Pro", online: true, workspaces: 3', 'DeviceRow(id: "m1", name: "Studio Mac", online: true, workspaces: 2'),
    ('DeviceRow(id: "m2", name: "Studio"', 'DeviceRow(id: "m2", name: "Build Server"'),
    ('MachineWorkspace(id: "w", name: "Cookrew Dev"), MachineWorkspace(id: "g", name: "GOAT Team"), MachineWorkspace(id: "p", name: "Playground")', 'MachineWorkspace(id: "w", name: "Release Room"), MachineWorkspace(id: "g", name: "Docs Site"), MachineWorkspace(id: "p", name: "Sandbox")'),
    ('titled("Cookrew Dev"', 'titled("Release Room"'),
    ('titled("MacBook Pro"', 'titled("Studio Mac"'),
    ('"Paired with MacBook Pro"', '"Paired with Studio Mac"'),
    ('desktop: "MacBook Pro", account: "drej"', 'desktop: "Studio Mac", account: "demo"'),
    ('desktop: "MacBook Pro", account: nil', 'desktop: "Studio Mac", account: nil'),
    ('      print("drew \\(list.count) screens into \\(out.path)")',
     '      for (index, shot) in list.enumerated() { write(Glass(size: CGSize(width: 198, height: 242), palette: .day) { shot.view }, scale: 3, to: out.appending(path: String(format: "w45-%02d.png", index + 1))) }\n      print("drew \\(list.count) screens into \\(out.path)")'),
]
missing = []
for old, new in pairs:
    if src.count(old) == 0:
        missing.append(old[:70])
    src = src.replace(old, new)
open(path, 'w', encoding='utf8').write(src)
leftover = [w for w in ['Atlas', 'Fresco', 'Gauge', 'Velvet', 'Tinker', '交互优化', 'Cookrew Dev', 'GOAT', 'MacBook Pro', 'watch-routes', 'drej'] if w in src]
print('missing:', missing)
print('leftover:', leftover)
sys.exit(1 if missing or leftover else 0)
