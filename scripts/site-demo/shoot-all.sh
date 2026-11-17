#!/bin/zsh
# scripts/site-demo/shoot-all.sh <shoot dir> — every still the site uses, into one directory (day; NIGHT=1 for the night set).
# Needs the fixture (serve.mjs, :5397), the demo pages (:5398) and the shoot Chrome (:9334); the watch screens are made by
# the watch recast (README step 4) and copied into <dir>/watch; the clip is clip.mjs against a headful Chrome (README).
set -e
export SHOOT_DIR=$1
here=${0:A:h}
mkdir -p $SHOOT_DIR
cd $here/../..
DSF=6 node $here/walk.mjs h 1024 640 0 light '[["press","button[aria-label=\"devices\"]"],["wait",5000],["shot","devices"],["press","button[aria-label=\"workspaces\"]"],["wait",1500],["shot","workspaces"],["press",".zv-door.agents","Docs Site"],["shot","docs"],["press","button[aria-label=\"workspaces\"]"],["press",".zv-door.agents","Release Room"],["shot","agents"],["press","button.zv-gf.agent.waiting"],["wait",2000],["shot","hitl"],["key","Escape"],["press",".zv-group.items .zv-group-stop"],["shot","artifacts"],["press",".zv-ip .zv-who, .zv-ip","Release notes"],["wait",2500],["shot","browser"],["press","button.zv-back"],["press","button[aria-label=\"workspaces\"]"],["press",".cr-board-badge"],["wait",1500],["shot","board"]]'
# Docs Site's two faces are a narrow column: ×8, so its crop is still over 1170 px.
DSF=8 node $here/walk.mjs h8 1024 640 0 light '[["press","button[aria-label=\"workspaces\"]"],["wait",1500],["press",".zv-door.agents","Docs Site"],["shot","docs"]]'
DSF=4 node $here/walk.mjs h 1440 900 0 light '[["press",".zv-door.agents","Release Room"],["press","button.zv-gf.agent.waiting"],["wait",1200],["shot","peek"],["key","Escape"],["press",".cr-more-btn"],["eval","(()=>{const b=[...document.querySelectorAll(\"button, [role=menuitem]\")].find(b=>b.textContent.trim()===\"Routing\"); b&&b.click(); return !!b})()"],["wait",2000],["shot","routing"]]'
DSF=3 node $here/walk.mjs p 390 844 1 light '[["press","button[aria-label=\"devices\"]"],["wait",5000],["shot","devices"],["press","button[aria-label=\"workspaces\"]"],["wait",1500],["shot","workspaces"],["press",".zv-door.agents","Release Room"],["press",".zv-group.agents .zv-group-stop"],["shot","crew"],["press","button.zv-gf.agent.waiting"],["wait",2500],["shot","card"]]'
node $here/ops.mjs
node $here/compose.mjs
