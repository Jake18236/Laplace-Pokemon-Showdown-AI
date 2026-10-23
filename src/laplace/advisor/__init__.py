"""Live move advisor: the search, driven by a browser userscript instead of by a ladder bot.

    player.py   AdvisorPlayer -- EnginePlayer that never sends a move, and AdviceCollector,
                which turns the search's observer events into one JSON advice dict per turn
    server.py   a local HTTP server: the userscript streams the battle protocol in, the
                advice comes back out
"""
