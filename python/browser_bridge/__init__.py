"""Use your existing browser through Browser Bridge, without a browser driver."""

from .client import (
    BrowserBridge,
    BridgeError,
    BridgeTimeoutError,
    Locator,
    NavigationResponse,
    Page,
    Response,
)

__all__ = [
    "BrowserBridge", "BridgeError", "BridgeTimeoutError", "Locator",
    "NavigationResponse", "Page", "Response",
]
