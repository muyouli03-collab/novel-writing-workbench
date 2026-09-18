"""网络端点判断辅助。"""
from ipaddress import ip_address
from urllib.parse import urlparse


def is_local_url(url: str) -> bool:
    """仅当 URL 的主机明确指向本机时返回 True。"""
    try:
        host = (urlparse((url or "").strip()).hostname or "").lower()
    except ValueError:
        return False
    if host == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False
