import atexit
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import (
    Flask,
    abort,
    jsonify,
    render_template,
    request,
    send_from_directory,
)
from werkzeug.exceptions import HTTPException

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "labels.db"

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp"}
VALID_STATUSES = {"pending", "in_progress", "done"}

app = Flask(
    __name__,
    static_folder=str(BASE_DIR / "static"),
    template_folder=str(BASE_DIR / "templates"),
)

_config_lock = threading.Lock()
_config_cache = None


def utcnow():
    return datetime.now(timezone.utc)


def timestamp():
    return utcnow().isoformat().replace("+00:00", "Z")


def load_config():
    global _config_cache
    with _config_lock:
        if _config_cache is None:
            with CONFIG_PATH.open("r", encoding="utf-8") as fh:
                _config_cache = json.load(fh)
        return _config_cache


def get_image_directory():
    config = load_config()
    image_dir = Path(config.get("image_directory", "images"))
    if not image_dir.is_absolute():
        image_dir = (BASE_DIR / image_dir).resolve()
    image_dir.mkdir(parents=True, exist_ok=True)
    return image_dir


def get_db_connection():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db_connection()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT UNIQUE NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                labels_json TEXT,
                reserved_by TEXT,
                reserved_at TEXT,
                skipped INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def sync_images():
    image_dir = get_image_directory()
    files = [
        f
        for f in sorted(image_dir.iterdir())
        if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS
    ]

    if not files:
        return

    conn = get_db_connection()
    try:
        cursor = conn.execute("SELECT filename FROM images")
        known_files = {row["filename"] for row in cursor.fetchall()}
        new_files = [f for f in files if f.name not in known_files]
        if not new_files:
            return
        now = timestamp()
        conn.executemany(
            """
            INSERT OR IGNORE INTO images (filename, status, labels_json, skipped, updated_at)
            VALUES (?, 'pending', NULL, 0, ?)
            """,
            [(f.name, now) for f in new_files],
        )
        conn.commit()
    finally:
        conn.close()


def reserve_next_image():
    sync_images()
    config = load_config()
    timeout_seconds = int(config.get("reservation_timeout_seconds", 300))
    now_dt = utcnow()
    expiry_threshold = now_dt - timedelta(seconds=timeout_seconds)
    expiry_threshold_iso = expiry_threshold.isoformat().replace("+00:00", "Z")
    now_iso = now_dt.isoformat().replace("+00:00", "Z")

    conn = get_db_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT id, filename, status, reserved_at
            FROM images
            WHERE status = 'pending'
               OR (
                   status = 'in_progress'
                   AND reserved_at IS NOT NULL
                   AND reserved_at <= ?
               )
            ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, id
            LIMIT 1
            """,
            (expiry_threshold_iso,),
        ).fetchone()

        if row is None:
            conn.commit()
            return None

        reservation_token = uuid.uuid4().hex
        conn.execute(
            """
            UPDATE images
            SET status = 'in_progress',
                reserved_by = ?,
                reserved_at = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (reservation_token, now_iso, now_iso, row["id"]),
        )
        conn.commit()
        return {"id": row["id"], "filename": row["filename"], "token": reservation_token}
    finally:
        conn.close()


def finalize_image(image_id, token, labels, skipped):
    now_iso = timestamp()
    labels_json = json.dumps(labels, sort_keys=True)
    conn = get_db_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT reserved_by FROM images WHERE id = ?", (image_id,)
        ).fetchone()
        if row is None:
            conn.rollback()
            return False, "Image not found"
        if row["reserved_by"] != token:
            conn.rollback()
            return False, "Reservation mismatch. Reload to get a new image."
        conn.execute(
            """
            UPDATE images
            SET status = 'done',
                labels_json = ?,
                reserved_by = NULL,
                reserved_at = NULL,
                skipped = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (labels_json, 1 if skipped else 0, now_iso, image_id),
        )
        conn.commit()
        return True, None
    finally:
        conn.close()


def release_all_reservations():
    conn = get_db_connection()
    try:
        conn.execute(
            """
            UPDATE images
            SET status = 'pending',
                reserved_by = NULL,
                reserved_at = NULL,
                updated_at = ?
            WHERE status = 'in_progress'
            """,
            (timestamp(),),
        )
        conn.commit()
    finally:
        conn.close()


def fetch_label_records(status=None, limit=None):
    query = (
        "SELECT id, filename, status, labels_json, skipped, reserved_by, "
        "reserved_at, updated_at FROM images"
    )
    clauses = []
    params = []

    if status and status in VALID_STATUSES:
        clauses.append("status = ?")
        params.append(status)

    if clauses:
        query += " WHERE " + " AND ".join(clauses)

    query += " ORDER BY id"

    if limit is not None and limit > 0:
        query += " LIMIT ?"
        params.append(limit)

    conn = get_db_connection()
    try:
        rows = conn.execute(query, params).fetchall()
    finally:
        conn.close()

    records = []
    for row in rows:
        labels_json = row[3]
        try:
            labels = json.loads(labels_json) if labels_json else {}
        except json.JSONDecodeError:
            labels = labels_json
        records.append(
            {
                "id": row[0],
                "filename": row[1],
                "status": row[2],
                "labels": labels,
                "skipped": bool(row[4]),
                "reserved_by": row[5],
                "reserved_at": row[6],
                "updated_at": row[7],
            }
        )

    return records


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/config")
def get_config():
    config = load_config()
    return jsonify(
        {
            "categories": config.get("categories", []),
            "image_directory": str(get_image_directory()),
        }
    )


@app.route("/api/image")
def api_image():
    reserved = reserve_next_image()
    if reserved is None:
        return jsonify({"status": "empty"})

    filename = reserved["filename"]
    image_url = f"/images/{filename}"
    return jsonify(
        {
            "status": "ok",
            "image": {
                "id": reserved["id"],
                "filename": filename,
                "url": image_url,
            },
            "reservation_token": reserved["token"],
        }
    )


@app.route("/api/label", methods=["POST"])
def api_label():
    payload = request.get_json(silent=True) or {}
    image_id = payload.get("image_id")
    token = payload.get("reservation_token")
    labels = payload.get("labels")

    if not image_id or not token:
        abort(400, "image_id and reservation_token are required")

    if not isinstance(labels, dict) or not any(labels.values()):
        abort(400, "At least one label must be selected to submit.")

    success, error = finalize_image(image_id, token, labels, skipped=False)
    if not success:
        abort(409, error)

    return jsonify({"status": "ok"})


@app.route("/api/skip", methods=["POST"])
def api_skip():
    payload = request.get_json(silent=True) or {}
    image_id = payload.get("image_id")
    token = payload.get("reservation_token")
    if not image_id or not token:
        abort(400, "image_id and reservation_token are required")

    success, error = finalize_image(image_id, token, labels={}, skipped=True)
    if not success:
        abort(409, error)

    return jsonify({"status": "ok"})


@app.route("/images/<path:filename>")
def serve_image(filename):
    image_dir = get_image_directory()
    safe_path = (image_dir / filename).resolve()
    if not safe_path.exists() or not safe_path.is_file():
        abort(404)
    try:
        safe_path.relative_to(image_dir)
    except ValueError:
        abort(404)
    return send_from_directory(image_dir, filename)


@app.errorhandler(HTTPException)
def handle_http_exception(exc):
    response = jsonify({"message": exc.description})
    response.status_code = exc.code
    return response


@app.errorhandler(Exception)
def handle_unexpected_exception(exc):
    app.logger.exception("Unhandled exception: %s", exc)
    return jsonify({"message": "Internal server error"}), 500


@app.route("/api/labels")
def api_labels_view():
    status_filter = request.args.get("status")
    limit = request.args.get("limit", type=int)
    records = fetch_label_records(status=status_filter, limit=limit)
    return jsonify({"records": records})


@app.route("/labels")
def labels_view():
    status_param = request.args.get("status", "all")
    limit = request.args.get("limit", type=int)

    status_filter = status_param if status_param in VALID_STATUSES else None
    records = fetch_label_records(status=status_filter, limit=limit)
    statuses = ["all"] + sorted(VALID_STATUSES)

    return render_template(
        "labels.html",
        records=records,
        statuses=statuses,
        current_status=status_param if status_param in statuses else "all",
        limit_value=limit if limit and limit > 0 else "",
        total_count=len(records),
    )


init_db()
release_all_reservations()
atexit.register(release_all_reservations)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
