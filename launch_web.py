"""Open the workbench only after its server has successfully started."""
import threading
import webbrowser

import uvicorn

URL = "http://127.0.0.1:8000"


def open_browser():
    try:
        if webbrowser.open(URL):
            return
    except Exception:
        pass
    print(f"Could not open your browser automatically. Open {URL}", flush=True)


class BrowserServer(uvicorn.Server):
    async def startup(self, sockets=None):
        await super().startup(sockets=sockets)
        if self.started and not self.should_exit:
            threading.Thread(target=open_browser, daemon=True).start()


if __name__ == "__main__":
    server = BrowserServer(uvicorn.Config("app.main:app", host="127.0.0.1", port=8000))
    server.run()
    raise SystemExit(0 if server.started else 1)
