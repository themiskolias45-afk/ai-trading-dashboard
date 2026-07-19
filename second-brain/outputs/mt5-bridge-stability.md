The MT5 Python bridge has been running but I want to confirm it stays stable overnight without crashing. Issues to watch:
- Does the MetaTrader5 Python connection drop after long idle periods?
- Does the bridge reconnect automatically if MT5 restarts?
- Memory leaks in the Python process over 24h+
- What happens if the broker server goes down during a live trade?
Current setup: bridge polls for signals every X seconds and sends orders via mt5.order_send(). MAGIC_NUMBER=20250101 to identify SmartEntry trades. Need to add reconnection logic and health check ping.
