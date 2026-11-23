# Browser check: Prism's tile page on its own and in a stand-in host built on the Game Host Kit, in Chromium.
#   python test/browser/check_tile.py [path to game-host-kit] [folder for screenshots]
# Serves this folder (and the kit's at /kit/) on 127.0.0.1, plays whole games by clicking, saves them, and checks
# each saved record replays through the engine. Screenshots at card and phone sizes go to the screenshots folder.
import sys, os, json, random, threading, http.server, socketserver
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KIT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(ROOT), "game-host-kit")
SHOTS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "test", "browser", "screenshots")
os.makedirs(SHOTS, exist_ok=True)
ok = True
def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name + (("  " + str(extra)) if extra else ""), flush=True)
    ok = ok and bool(cond)

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm"}
    def translate_path(self, path):
        path = path.split("?", 1)[0]
        if path.startswith("/kit/"):
            return os.path.join(KIT, path[len("/kit/"):])
        return os.path.join(ROOT, path.lstrip("/"))
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 8793), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:8793"
rng = random.Random(7)

def play_to_end(g, page, illegal_try=True):
    """Plays one game by clicking: pick a random die, then a random lit cell. Returns the number of placements."""
    if g.locator("#castBtn").count():
        g.locator("#castBtn").click()
    placed = 0
    for _ in range(200):
        if g.locator("#endPanel").is_visible():
            return placed
        dice = g.locator("#tray .die:not(.frozen)")
        n = dice.count()
        if n == 0:
            page.wait_for_timeout(50); continue
        order = list(range(n)); rng.shuffle(order)
        done = False
        for i in order:
            g.locator(f'#tray .die[data-die="{i}"]').click()
            lit = g.locator(".cell.lit")
            if lit.count() == 0:
                continue
            if illegal_try and placed == 0:
                # A dark cell does nothing.
                dark = g.locator(".cell:not(.lit)")
                if dark.count():
                    before = g.locator("#board .die").count()
                    dark.first.click(force=True)
                    check("a cell that isn't lit takes nothing", g.locator("#board .die").count() == before)
            k = rng.randrange(lit.count())
            lit.nth(k).click()
            placed += 1
            done = True
            break
        if not done:
            raise RuntimeError("no die could go anywhere, but the game isn't over")
    raise RuntimeError("the game didn't end")

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        errors, outside = [], []
        def watch(pg):
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "web-tiles/data.js" not in m.text and "404" not in m.text else None)
            pg.on("request", lambda r: outside.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith("data:") and not r.url.startswith("blob:") else None)

        # 1. On its own: plays, offers nothing.
        page = b.new_page(viewport={"width": 380, "height": 460})
        watch(page)
        page.goto(f"{BASE}/tile/index.html")
        page.locator("#castBtn").wait_for(timeout=8000)
        check("on its own: the board and Cast dice show", page.locator("#board .cell").count() == 12)
        check("on its own: the restricted cells are drawn (2 colour-tinted, 2 with faint pips... and violet)",
              page.locator('.cell[aria-label^="only"]').count() == 5)
        check("on its own: Daily is chosen, with today's label", page.locator("#dailyBtn").get_attribute("aria-pressed") == "true" and page.locator("#dayLabel").text_content().startswith("Daily · "))
        page.screenshot(path=os.path.join(SHOTS, "1-card-380x460-start.png"))
        page.locator("#castBtn").click()
        page.wait_for_timeout(1300)
        check("casting shows four dice in the pool", page.locator("#tray .die").count() == 4)
        check("the draws counter starts at 0 of 24", page.locator("#draws").text_content() == "draws 0 of 24", page.locator("#draws").text_content())
        page.locator('#tray .die[data-die="0"]').click()
        lit = page.locator(".cell.lit").count()
        check("picking a die lights the cells it may go on (first die: edge cells only)", lit > 0 and page.locator('.cell.lit[data-cell="5"]').count() == 0 and page.locator('.cell.lit[data-cell="6"]').count() == 0, lit)
        page.screenshot(path=os.path.join(SHOTS, "2-card-380x460-picked.png"))
        page.locator(".cell.lit").first.click()
        check("placing puts the die on the board and counts a draw", page.locator("#board .die").count() == 1 and page.locator("#draws").text_content() == "draws 1 of 24")
        placed = play_to_end(page, page, illegal_try=False)
        check("a whole daily game plays to the end", page.locator("#endPanel").is_visible(), f"{placed + 1} placements")
        check("on its own: no Save button and no note", not page.locator("#saveBtn").is_visible() and not page.locator("#saveNote").is_visible())
        check("on its own: no 'Playing as' line", page.locator("#who").text_content() == "")
        end_label = page.locator("#endLabel").text_content()
        check("the end screen names the daily game", end_label.startswith("Prism · daily, "), end_label)
        parts = page.locator("#endParts").text_content()
        check("the end screen gives the score parts", "filled" in parts and "rainbow row" in parts and "empty" in parts, parts)
        draws = page.locator("#draws").text_content()
        check("the draws counter never passes 24", int(draws.split()[1]) <= 24, draws)
        page.screenshot(path=os.path.join(SHOTS, "3-card-380x460-end.png"))
        # The same day's game again: the same dice (seeded from the day).
        page.locator("#againBtn").click(); page.locator("#castBtn").click(); page.wait_for_timeout(1300)
        first = page.locator("#tray").get_attribute("aria-label") and [page.locator(f'#tray .die[data-die="{i}"]').get_attribute("aria-label") for i in range(4)]
        page.locator("#againBtn").evaluate("b => b.click()") if page.locator("#endPanel").is_visible() else None
        page.locator("#dailyBtn").click(); page.locator("#castBtn").click(); page.wait_for_timeout(1300)
        second = [page.locator(f'#tray .die[data-die="{i}"]').get_attribute("aria-label") for i in range(4)]
        check("the daily game deals the same dice every time today", first == second, (first, second))
        page.locator("#freeBtn").click(); page.locator("#castBtn").click(); page.wait_for_timeout(1300)
        f1 = [page.locator(f'#tray .die[data-die="{i}"]').get_attribute("aria-label") for i in range(4)]
        page.locator("#freeBtn").click(); page.locator("#castBtn").click(); page.wait_for_timeout(1300)
        f2 = [page.locator(f'#tray .die[data-die="{i}"]').get_attribute("aria-label") for i in range(4)]
        check("free play deals fresh dice each game", f1 != second or f2 != second, (f1, f2))
        check("free play: the board is marked (dashed) and labelled", "free" in page.locator("#board").get_attribute("class") and page.locator("#dayLabel").text_content() == "Free play")

        # 2. Sizes: a smaller card and a phone.
        for (w, h, name) in [(340, 300, "4-card-340x300"), (390, 844, "5-phone-390x844"), (300, 250, "6-tiny-300x250")]:
            pg = b.new_page(viewport={"width": w, "height": h})
            watch(pg)
            pg.goto(f"{BASE}/tile/index.html")
            pg.locator("#castBtn").click(); pg.wait_for_timeout(1300)
            pg.locator('#tray .die[data-die="0"]').click()
            cell = pg.evaluate("parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cell'))")
            bottom = pg.evaluate("document.getElementById('bar').getBoundingClientRect().bottom")
            right = pg.evaluate("document.getElementById('board').getBoundingClientRect().right")
            check(f"{w}x{h}: everything fits (cells {cell}px)", bottom <= h + 1 and right <= w + 1, (bottom, right))
            pg.screenshot(path=os.path.join(SHOTS, f"{name}.png"))
            pg.close()

        # 3. In the stand-in host: who's playing, a daily game saved and checked, then free play.
        page = b.new_page(viewport={"width": 1000, "height": 640})
        watch(page)
        page.goto(f"{BASE}/test/browser/host.html")
        g = page.frame_locator("#game")
        g.locator("#who").filter(has_text="Playing as @alice.example").wait_for(timeout=8000)
        check("in the host: the game hears who's playing", True)
        play_to_end(g, page)
        check("in the host: Save shows at the end", g.locator("#saveBtn").is_visible())
        page.screenshot(path=os.path.join(SHOTS, "7-host-end.png"))
        g.locator("#saveBtn").click()
        page.locator("#ask").wait_for(state="visible", timeout=5000)
        rec = json.loads(page.locator("#askRecord").text_content())
        check("the host checked the game by replaying it through the engine before asking", "✓" in page.locator("#askCheck").text_content())
        check("the record is a daily game: mode, day, moves, board, score parts; no seed",
              rec["mode"] == "daily" and len(rec["day"]) == 10 and "seed" not in rec and len(rec["board"]) == 12 and isinstance(rec["moves"], list) and all(k in rec for k in ("filled", "empty", "rainbowRows", "score")), rec)
        check("the host added the game's address and version", rec["game"]["uri"].endswith("3prismstandin") and rec["$type"] == "cafe.thunderbird.prism.game")
        today = page.evaluate("new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())")
        check("its day is today's Denver day", rec["day"] == today, (rec["day"], today))
        check("its board matches the score shown", str(rec["score"]) == g.locator("#endScore").text_content())
        page.locator("#ask button[value=yes]").click()
        g.locator("#saveStatus").filter(has_text="Saved to @alice.example's account").wait_for(timeout=5000)
        check("saved, and the game says so; See it shows, Save hides", g.locator("#seeBtn").is_visible() and not g.locator("#saveBtn").is_visible())
        g.locator("#seeBtn").click(); page.wait_for_timeout(200)
        check("See it asks the host to show the saved record", page.evaluate("window.opened") == page.evaluate("window.saved[0].uri"))
        page.screenshot(path=os.path.join(SHOTS, "8-host-saved.png"))

        g.locator("#freeBtn").click()
        play_to_end(g, page)
        g.locator("#saveBtn").click()
        page.locator("#ask").wait_for(state="visible", timeout=5000)
        rec2 = json.loads(page.locator("#askRecord").text_content())
        check("free play: the record carries its seed, no day", rec2["mode"] == "free" and isinstance(rec2["seed"], int) and "day" not in rec2, rec2)
        page.locator("#ask button[value=no]").click()
        g.locator("#saveStatus").filter(has_text="Not saved.").wait_for(timeout=5000)
        check("declined: the game says Not saved, and Save comes back", g.locator("#saveBtn").is_visible())
        check("the end screen says free play", g.locator("#endLabel").text_content() == "Prism · free play")

        # Both saved and declined records replay through the engine in Node too (test/replay-record.mjs).
        import subprocess
        for r in (rec, rec2):
            out = subprocess.run(["node", os.path.join(ROOT, "test", "browser", "replay-record.mjs")], input=json.dumps(r), capture_output=True, text=True)
            check(f"the {r['mode']} record replays in Node to the same board and score", out.stdout.strip() == "ok", out.stdout + out.stderr)

        # 4. A host that saves for other games but not Prism; and no one signed in.
        page2 = b.new_page(viewport={"width": 1000, "height": 640})
        watch(page2)
        page2.goto(f"{BASE}/test/browser/host.html?save=0&who=none")
        g2 = page2.frame_locator("#game")
        g2.locator("#who").filter(has_text="Playing as a guest").wait_for(timeout=8000)
        check("no one signed in: the game says guest", True)
        play_to_end(g2, page2, illegal_try=False)
        check("a host that doesn't save Prism: no Save, and the note says so", not g2.locator("#saveBtn").is_visible() and g2.locator("#saveNote").is_visible())

        check("nothing was fetched from outside the test server", not outside, outside[:5])
        check("no page errors", not errors, errors[:5])
        b.close()
finally:
    srv.shutdown()
print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
