#!/usr/bin/env python3
"""XP&UP: дашборд регистраций участников.

Без внешних зависимостей: только стандартная библиотека Python 3.9+ и SQLite.

Запуск:   python server.py
Страницы: /          дашборд (нужен пароль администратора)
          /register  публичная форма регистрации для участников
API:      см. README.md
"""
import base64
import csv
import hashlib
import hmac
import io
import json
import mimetypes
import os
import random
import re
import secrets
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

for _stream in (sys.stdout, sys.stderr):  # русский текст в консоли Windows
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"


# ---------------------------------------------------------------- настройки
def load_env_file(path: Path) -> None:
    """Читает KEY=VALUE из .env, не перезаписывая уже заданные переменные."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(BASE / ".env")
load_env_file(BASE.parent / ".env")

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE.parent / "data"))
CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "").strip()  # адрес сайта, с которого шлются регистрации
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "").lower() in ("1", "true", "yes")
SESSION_HOURS = int(os.environ.get("SESSION_HOURS", "12"))
COOKIE_NAME = "xpup_session"
MAX_BODY = 2 * 1024 * 1024

DATA_DIR.mkdir(parents=True, exist_ok=True)

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
GENERATED_PASSWORD = False
if not ADMIN_PASSWORD:
    pw_file = DATA_DIR / "admin_password.txt"
    if pw_file.is_file():
        ADMIN_PASSWORD = pw_file.read_text(encoding="utf-8").strip()
    else:
        ADMIN_PASSWORD = secrets.token_urlsafe(9)
        pw_file.write_text(ADMIN_PASSWORD, encoding="utf-8")
        GENERATED_PASSWORD = True

secret_file = DATA_DIR / "secret.key"
if secret_file.is_file():
    SECRET = secret_file.read_bytes()
else:
    SECRET = secrets.token_bytes(32)
    secret_file.write_bytes(SECRET)


# --------------------------------------------------------------------- база
DB_LOCK = threading.Lock()
DB = sqlite3.connect(DATA_DIR / "registrations.db", check_same_thread=False)
DB.row_factory = sqlite3.Row
DB.execute("PRAGMA journal_mode=WAL")
DB.executescript(
    """
    CREATE TABLE IF NOT EXISTS participants (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        email      TEXT NOT NULL DEFAULT '',
        city       TEXT NOT NULL DEFAULT '',
        age        INTEGER,
        track      TEXT NOT NULL DEFAULT '',
        source     TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        demo       INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_email
        ON participants (lower(email)) WHERE email <> '';
    CREATE INDEX IF NOT EXISTS ix_participants_created ON participants (created_at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """
)
DB.commit()

STATUSES = ("pending", "confirmed", "cancelled")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def row_to_json(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"], "name": r["name"], "email": r["email"], "city": r["city"],
        "age": r["age"], "track": r["track"], "source": r["source"],
        "status": r["status"], "createdAt": r["created_at"], "demo": bool(r["demo"]),
    }


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def clean_text(value, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def normalize(data: dict, require_email: bool = False) -> dict:
    """Проверяет и приводит запись участника к виду для БД."""
    name = clean_text(data.get("name"), 120)
    email = clean_text(data.get("email"), 160).lower()
    if not name:
        raise ApiError(400, "Укажите имя.")
    if email and not EMAIL_RE.match(email):
        raise ApiError(400, "Некорректный email.")
    if require_email and not email:
        raise ApiError(400, "Укажите email.")
    age = data.get("age")
    try:
        age = int(age) if age not in (None, "") else None
    except (TypeError, ValueError):
        age = None
    if age is not None and not 10 <= age <= 99:
        age = None
    status = data.get("status") or "pending"
    if status not in STATUSES:
        raise ApiError(400, "Неизвестный статус.")
    created = data.get("createdAt") or now_iso()
    try:
        parsed = datetime.fromisoformat(str(created).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        created = parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    except ValueError:
        created = now_iso()
    return {
        "name": name, "email": email, "city": clean_text(data.get("city"), 80), "age": age,
        "track": clean_text(data.get("track"), 60), "source": clean_text(data.get("source"), 60),
        "status": status, "created_at": created, "demo": 1 if data.get("demo") else 0,
    }


def insert_participant(rec: dict) -> dict:
    rec = dict(rec, id=uuid.uuid4().hex[:16])
    try:
        DB.execute(
            "INSERT INTO participants (id,name,email,city,age,track,source,status,created_at,demo) "
            "VALUES (:id,:name,:email,:city,:age,:track,:source,:status,:created_at,:demo)", rec)
    except sqlite3.IntegrityError:
        raise ApiError(409, "Участник с таким email уже зарегистрирован.")
    return rec


def list_participants() -> list:
    with DB_LOCK:
        rows = DB.execute("SELECT * FROM participants ORDER BY created_at DESC").fetchall()
    return [row_to_json(r) for r in rows]


def get_capacity() -> int:
    with DB_LOCK:
        row = DB.execute("SELECT value FROM settings WHERE key='capacity'").fetchone()
    try:
        return max(1, int(row["value"])) if row else 150
    except ValueError:
        return 150


# -------------------------------------------------------------- демо-данные
def seed_demo() -> int:
    rnd = random.Random(7)
    first = ["Анна", "Дмитрий", "Мария", "Иван", "Елена", "Алексей", "Ольга", "Сергей", "Наталья", "Артём",
             "Ксения", "Павел", "Виктория", "Никита", "Дарья", "Максим", "Юлия", "Андрей", "Полина", "Егор"]
    last = {"Иванов": "ivanov", "Петрова": "petrova", "Смирнов": "smirnov", "Кузнецова": "kuznetsova",
            "Попов": "popov", "Соколова": "sokolova", "Лебедев": "lebedev", "Козлова": "kozlova",
            "Новиков": "novikov", "Морозова": "morozova", "Волков": "volkov", "Фёдорова": "fedorova",
            "Орлов": "orlov", "Зайцева": "zaitseva", "Беляев": "belyaev"}
    cities = ["Москва", "Санкт-Петербург", "Казань", "Новосибирск", "Екатеринбург", "Нижний Новгород", "Самара", "Краснодар"]
    sources = ["Telegram", "Instagram", "Сайт", "Рассылка", "Друзья", "Партнёры"]
    tracks = ["Разработка", "Дизайн", "Маркетинг", "Бизнес"]
    now = datetime.now(timezone.utc)
    added = 0
    with DB_LOCK:
        for i in range(64):
            day = int(rnd.random() ** 1.6 * 44)
            created = now - timedelta(days=day, hours=rnd.randint(0, 11))
            surname = rnd.choice(list(last))
            src = rnd.choices(sources, [32, 22, 16, 12, 10, 8])[0]
            r = rnd.random()
            status = "confirmed" if r < .55 else "pending" if r < .87 else "cancelled"
            if day > 30 and status == "pending":
                status = "confirmed" if rnd.random() < .6 else "cancelled"
            if src == "Партнёры" and rnd.random() < .5:
                status = "confirmed"
            rec = {
                "name": f"{rnd.choice(first)} {surname}", "email": f"demo{i + 1}.{last[surname]}@example.com",
                "city": rnd.choices(cities, [30, 20, 10, 8, 8, 7, 6, 5])[0],
                "age": round(18 + rnd.random() ** 1.4 * 32),
                "track": rnd.choices(tracks, [38, 24, 20, 18])[0], "source": src, "status": status,
                "created_at": created.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "demo": 1,
            }
            try:
                insert_participant(rec)
                added += 1
            except ApiError:
                pass
        DB.commit()
    return added


# -------------------------------------------------------- сессии и лимиты
def sign(payload: str) -> str:
    return hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()


def make_session() -> str:
    exp = str(int(time.time()) + SESSION_HOURS * 3600)
    nonce = secrets.token_hex(8)
    payload = f"{exp}.{nonce}"
    return base64.urlsafe_b64encode(f"{payload}.{sign(payload)}".encode()).decode()


def valid_session(token: str) -> bool:
    try:
        exp, nonce, mac = base64.urlsafe_b64decode(token.encode()).decode().split(".")
        return hmac.compare_digest(mac, sign(f"{exp}.{nonce}")) and int(exp) > time.time()
    except Exception:
        return False


class RateLimiter:
    def __init__(self, limit: int, window: int):
        self.limit, self.window, self.hits, self.lock = limit, window, {}, threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.time()
        with self.lock:
            hits = [t for t in self.hits.get(key, []) if now - t < self.window]
            if len(hits) >= self.limit:
                self.hits[key] = hits
                return False
            hits.append(now)
            self.hits[key] = hits
            return True


LOGIN_LIMIT = RateLimiter(8, 300)      # 8 попыток входа за 5 минут с одного адреса
REGISTER_LIMIT = RateLimiter(10, 3600)  # 10 регистраций в час с одного адреса


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "XPUP/1.0"
    protocol_version = "HTTP/1.1"

    # --- вспомогательное
    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

    def client_ip(self) -> str:
        fwd = self.headers.get("X-Forwarded-For")
        if fwd and os.environ.get("TRUST_PROXY", "").lower() in ("1", "true", "yes"):
            return fwd.split(",")[0].strip()
        return self.client_address[0]

    def is_admin(self) -> bool:
        raw = self.headers.get("Cookie", "")
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE_NAME:
                return valid_session(v)
        return False

    def require_admin(self):
        if not self.is_admin():
            raise ApiError(401, "Требуется вход.")

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "Слишком большой запрос.")
        if length and "application/json" not in (self.headers.get("Content-Type") or ""):
            raise ApiError(415, "Ожидается application/json.")
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "Некорректный JSON.")
        if not isinstance(data, dict):
            raise ApiError(400, "Ожидается JSON-объект.")
        return data

    def send_bytes(self, status: int, body: bytes, ctype: str, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status: int, obj, extra=None):
        headers = {"Cache-Control": "no-store"}
        headers.update(extra or {})
        self.send_bytes(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", headers)

    def cors_headers(self) -> dict:
        if CORS_ORIGIN and self.headers.get("Origin") == CORS_ORIGIN:
            return {"Access-Control-Allow-Origin": CORS_ORIGIN, "Vary": "Origin"}
        return {}

    # --- маршрутизация
    def do_HEAD(self):
        self.route("GET")

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PATCH(self):
        self.route("PATCH")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def do_OPTIONS(self):
        headers = self.cors_headers()
        if headers and urlparse(self.path).path == "/api/register":
            headers.update({"Access-Control-Allow-Methods": "POST, OPTIONS",
                            "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600"})
        self.send_bytes(204, b"", "text/plain", headers)

    def route(self, method: str):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        try:
            if path.startswith("/api/"):
                self.api(method, path, parse_qs(parsed.query))
            elif method == "GET":
                self.static(path)
            else:
                raise ApiError(405, "Метод не поддерживается.")
        except ApiError as e:
            if path.startswith("/api/"):
                self.send_json(e.status, {"error": e.message}, self.cors_headers())
            else:
                self.send_bytes(e.status, e.message.encode("utf-8"), "text/plain; charset=utf-8")
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"Ошибка: {e!r}\n")
            if path.startswith("/api/"):
                self.send_json(500, {"error": "Внутренняя ошибка сервера."})
            else:
                self.send_bytes(500, b"Internal error", "text/plain")

    # --- статические файлы
    def static(self, path: str):
        pages = {"/": "index.html", "/register": "register.html", "/register/": "register.html"}
        if path in pages:
            rel = pages[path]
        elif path.startswith("/static/"):
            rel = path[len("/static/"):]
        else:
            raise ApiError(404, "Не найдено.")
        target = (STATIC / rel).resolve()
        if STATIC.resolve() not in target.parents or not target.is_file():
            raise ApiError(404, "Не найдено.")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        headers = {"Cache-Control": "no-cache"}
        if rel == "index.html":
            headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            headers["X-Frame-Options"] = "DENY"
        self.send_bytes(200, target.read_bytes(), ctype, headers)

    # --- API
    def api(self, method: str, path: str, query: dict):
        parts = [p for p in path.split("/") if p][1:]  # без "api"

        if parts == ["register"] and method == "POST":
            return self.api_register()
        if parts == ["login"] and method == "POST":
            return self.api_login()
        if parts == ["logout"] and method == "POST":
            return self.send_json(200, {"ok": True}, {"Set-Cookie": self.cookie("", 0)})
        if parts == ["me"] and method == "GET":
            return self.send_json(200, {"admin": self.is_admin()})

        self.require_admin()

        if parts == ["participants"]:
            if method == "GET":
                return self.send_json(200, {"participants": list_participants(), "capacity": get_capacity()})
            if method == "POST":
                data = self.read_json()
                with DB_LOCK:
                    rec = insert_participant(normalize(data))
                    DB.commit()
                return self.send_json(201, {"id": rec["id"]})
        if parts == ["participants", "import"] and method == "POST":
            return self.api_import()
        if len(parts) == 2 and parts[0] == "participants":
            pid = parts[1]
            if method == "PATCH":
                data = self.read_json()
                if "status" not in data or data["status"] not in STATUSES:
                    raise ApiError(400, "Допустимо менять только статус.")
                with DB_LOCK:
                    cur = DB.execute("UPDATE participants SET status=? WHERE id=?", (data["status"], pid))
                    DB.commit()
                if not cur.rowcount:
                    raise ApiError(404, "Участник не найден.")
                return self.send_json(200, {"ok": True})
            if method == "DELETE":
                with DB_LOCK:
                    DB.execute("DELETE FROM participants WHERE id=?", (pid,))
                    DB.commit()
                return self.send_json(200, {"ok": True})
        if parts == ["settings"] and method == "PUT":
            data = self.read_json()
            try:
                capacity = int(data.get("capacity"))
            except (TypeError, ValueError):
                raise ApiError(400, "Некорректное количество мест.")
            if not 1 <= capacity <= 1_000_000:
                raise ApiError(400, "Некорректное количество мест.")
            with DB_LOCK:
                DB.execute("INSERT INTO settings(key,value) VALUES('capacity',?) "
                           "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(capacity),))
                DB.commit()
            return self.send_json(200, {"capacity": capacity})
        if parts == ["demo"]:
            if method == "POST":
                return self.send_json(200, {"added": seed_demo()})
            if method == "DELETE":
                with DB_LOCK:
                    cur = DB.execute("DELETE FROM participants WHERE demo=1")
                    DB.commit()
                return self.send_json(200, {"deleted": cur.rowcount})
        if parts == ["export.csv"] and method == "GET":
            return self.api_export()
        raise ApiError(404, "Не найдено.")

    def cookie(self, value: str, max_age: int) -> str:
        c = f"{COOKIE_NAME}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
        return c + ("; Secure" if COOKIE_SECURE else "")

    def api_login(self):
        if not LOGIN_LIMIT.allow(self.client_ip()):
            raise ApiError(429, "Слишком много попыток. Подождите несколько минут.")
        password = str(self.read_json().get("password", ""))
        if not hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode()):
            time.sleep(0.4)
            raise ApiError(401, "Неверный пароль.")
        self.send_json(200, {"ok": True}, {"Set-Cookie": self.cookie(make_session(), SESSION_HOURS * 3600)})

    def api_register(self):
        """Публичная регистрация с сайта. Статус всегда «Ожидает»."""
        headers = self.cors_headers()
        if not REGISTER_LIMIT.allow(self.client_ip()):
            raise ApiError(429, "Слишком много заявок. Попробуйте позже.")
        data = self.read_json()
        if data.get("website"):  # ловушка для ботов: поле скрыто от людей
            return self.send_json(200, {"ok": True}, headers)
        safe = {k: data.get(k) for k in ("name", "email", "city", "age", "track", "source")}
        safe["status"] = "pending"
        with DB_LOCK:
            insert_participant(normalize(safe, require_email=True))
            DB.commit()
        self.send_json(201, {"ok": True}, headers)

    def api_import(self):
        items = self.read_json().get("items")
        if not isinstance(items, list) or not items:
            raise ApiError(400, "Нет записей для импорта.")
        added = skipped = 0
        with DB_LOCK:
            for item in items[:2000]:
                try:
                    insert_participant(normalize(item if isinstance(item, dict) else {}))
                    added += 1
                except ApiError:
                    skipped += 1
            DB.commit()
        self.send_json(200, {"added": added, "skipped": skipped})

    def api_export(self):
        labels = {"pending": "Ожидает", "confirmed": "Подтверждён", "cancelled": "Отменён"}
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["Имя", "Email", "Город", "Возраст", "Направление", "Источник", "Статус", "Дата регистрации"])
        for p in list_participants():
            w.writerow([p["name"], p["email"], p["city"], p["age"] or "", p["track"], p["source"],
                        labels[p["status"]], p["createdAt"][:10]])
        body = ("﻿" + buf.getvalue()).encode("utf-8")
        self.send_bytes(200, body, "text/csv; charset=utf-8", {
            "Content-Disposition": 'attachment; filename="xpup-registrations.csv"', "Cache-Control": "no-store"})


def main():
    if "--seed-demo" in sys.argv:
        print(f"Добавлено демо-записей: {seed_demo()}")
        return
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"XP&UP запущен: http://{HOST}:{PORT}/   (форма регистрации: /register)")
    print(f"Данные: {DATA_DIR}")
    if GENERATED_PASSWORD:
        print(f"Пароль администратора создан и сохранён в {DATA_DIR / 'admin_password.txt'}: {ADMIN_PASSWORD}")
    else:
        print("Пароль администратора: переменная ADMIN_PASSWORD или файл data/admin_password.txt")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")


if __name__ == "__main__":
    main()
