import base64, os, re, time, uuid
from pathlib import Path
import fitz
from flask import Flask, render_template, request, jsonify, send_file, make_response
from werkzeug.exceptions import RequestEntityTooLarge

app = Flask(__name__)
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "output"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)
SESSIONS = {}

def get_positive_int_env(name, default):
    try:
        value = int(os.environ.get(name, "").strip())
        return value if value > 0 else default
    except ValueError:
        return default

MAX_UPLOAD_MB = get_positive_int_env("MAX_UPLOAD_MB", 20)
MAX_PDF_PAGES = get_positive_int_env("MAX_PDF_PAGES", 20)
FILE_TTL_SECONDS = get_positive_int_env("FILE_TTL_SECONDS", 6 * 60 * 60)
DOWNLOAD_FILENAME_RE = re.compile(
    r"^direct_result_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$",
    re.IGNORECASE,
)

app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

class PdfValidationError(Exception):
    pass

def json_error(message, status=400):
    return jsonify({"error": message}), status

@app.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(error):
    return json_error(
        f"PDFファイルのサイズが大きすぎます。{MAX_UPLOAD_MB}MB以内のPDFを選択してください。",
        413,
    )

def cleanup_expired_resources():
    now = time.time()

    for session_id, session in list(SESSIONS.items()):
        updated_at = session.get("updated_at", session.get("created_at", now))
        if now - updated_at > FILE_TTL_SECONDS:
            SESSIONS.pop(session_id, None)

    active_uploads = set()
    for session in SESSIONS.values():
        pdf_path = session.get("pdf_path")
        if not pdf_path:
            continue
        try:
            active_uploads.add(Path(pdf_path).resolve())
        except OSError:
            continue

    for directory in (UPLOAD_DIR, OUTPUT_DIR):
        for path in directory.glob("*.pdf"):
            try:
                resolved_path = path.resolve()
                if resolved_path in active_uploads:
                    continue
                if now - path.stat().st_mtime > FILE_TTL_SECONDS:
                    path.unlink()
            except OSError:
                continue

def get_request_json():
    return request.get_json(silent=True) or {}

def get_session(session_id):
    session = SESSIONS.get(session_id)
    if session:
        session["updated_at"] = time.time()
    return session

def has_pdf_header(file):
    try:
        file.stream.seek(0)
        header = file.stream.read(4)
        file.stream.seek(0)
        return header == b"%PDF"
    except OSError:
        return False

def validate_pdf_file(pdf_path):
    doc = None
    try:
        doc = fitz.open(str(pdf_path))
        page_count = len(doc)
        if page_count < 1:
            raise PdfValidationError("ページが含まれていないPDFは使用できません。")
        if page_count > MAX_PDF_PAGES:
            raise PdfValidationError(
                f"PDFのページ数が多すぎます。{MAX_PDF_PAGES}ページ以内のPDFを選択してください。"
            )
        return page_count
    except PdfValidationError:
        raise
    except Exception as exc:
        raise PdfValidationError("PDFファイルを開けませんでした。別のPDFを選択してください。") from exc
    finally:
        if doc is not None:
            doc.close()

def remove_file_safely(path):
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass

def resolve_download_path(filename):
    if not filename or filename != Path(filename).name:
        return None
    if ".." in filename or "/" in filename or "\\" in filename:
        return None
    if not DOWNLOAD_FILENAME_RE.fullmatch(filename):
        return None

    try:
        output_dir = OUTPUT_DIR.resolve()
        file_path = (OUTPUT_DIR / filename).resolve()
    except OSError:
        return None

    if file_path.parent != output_dir:
        return None
    if not file_path.is_file():
        return None
    return file_path

def choose_fontname(text):
    try:
        text.encode("ascii")
        return "helv"
    except UnicodeEncodeError:
        return "japan"

def estimate_text_width(text, font_size):
    width = 0
    for ch in text:
        if ch == "\n":
            continue
        try:
            ch.encode("ascii")
            width += font_size * 0.6
        except UnicodeEncodeError:
            width += font_size
    return width

def wrap_text(text, font_size, max_width):
    result = []
    for paragraph in text.splitlines() or [""]:
        current = ""
        for ch in paragraph:
            test = current + ch
            if current and estimate_text_width(test, font_size) > max_width:
                result.append(current)
                current = ch
            else:
                current = test
        if current:
            result.append(current)
    return result if result else [""]

def draw_item_to_pdf_page(page, item):
    lines = item.get("lines") or wrap_text(
        item["text"], item["font_size"], item.get("wrap_width", 9999)
    )
    line_height = item["font_size"] * 1.25
    for i, line in enumerate(lines):
        page.insert_text(
            (item["x"], item["y"] + (i * line_height)),
            line,
            fontsize=item["font_size"],
            fontname=choose_fontname(line),
            color=(0, 0, 0),
        )

def render_preview_image(pdf_path, page_index, items, zoom=1.5):
    doc = fitz.open(str(pdf_path))
    try:
        page = doc[page_index]

        for item in items:
            if item["page"] == page_index:
                draw_item_to_pdf_page(page, item)

        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        png_bytes = pix.tobytes("png")

        return {
            "image": "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii"),
            "page_width": page.rect.width,
            "page_height": page.rect.height,
            "zoom": zoom,
        }
    finally:
        doc.close()

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/upload", methods=["POST"])
def upload_pdf():
    cleanup_expired_resources()

    file = request.files.get("pdf")
    if not file:
        return json_error("PDFファイルがありません。")
    if not (file.filename or "").lower().endswith(".pdf"):
        return json_error("PDFファイルを選択してください。")
    if not has_pdf_header(file):
        return json_error("PDFファイルを選択してください。")

    session_id = str(uuid.uuid4())
    pdf_path = UPLOAD_DIR / f"{session_id}.pdf"

    try:
        file.save(pdf_path)
        page_count = validate_pdf_file(pdf_path)
    except PdfValidationError as exc:
        remove_file_safely(pdf_path)
        return json_error(str(exc))
    except Exception:
        remove_file_safely(pdf_path)
        return json_error("PDFファイルを保存できませんでした。時間をおいて再度お試しください。", 500)

    SESSIONS[session_id] = {
        "pdf_path": str(pdf_path),
        "items": [],
        "page_count": page_count,
        "zoom": 1.5,
        "created_at": time.time(),
        "updated_at": time.time(),
    }

    try:
        preview = render_preview_image(pdf_path, 0, [], zoom=1.5)
    except Exception:
        SESSIONS.pop(session_id, None)
        remove_file_safely(pdf_path)
        return json_error("PDFファイルを表示できませんでした。別のPDFを選択してください。")

    return jsonify({
        "session_id": session_id,
        "page_count": page_count,
        "current_page": 0,
        "items_count": 0,
        **preview,
    })

@app.route("/preview", methods=["POST"])
def preview():
    data = get_request_json()
    session = get_session(data.get("session_id"))
    if not session:
        return jsonify({"error": "PDFを開き直してください。"}), 404

    page_index = max(0, min(int(data.get("page", 0)), session["page_count"] - 1))
    preview_data = render_preview_image(
        Path(session["pdf_path"]), page_index, session["items"], zoom=session["zoom"]
    )
    return jsonify({
        "current_page": page_index,
        "page_count": session["page_count"],
        "items_count": len(session["items"]),
        **preview_data,
    })

@app.route("/add_text", methods=["POST"])
def add_text():
    data = get_request_json()
    session = get_session(data.get("session_id"))
    if not session:
        return jsonify({"error": "PDFを開き直してください。"}), 404

    item = {
        "page": int(data["page"]),
        "text": data["text"],
        "x": round(float(data["x"]), 2),
        "y": round(float(data["y"]), 2),
        "font_size": float(data["font_size"]),
        "wrap_width": round(float(data["wrap_width"]), 2),
    }
    item["lines"] = wrap_text(item["text"], item["font_size"], item["wrap_width"])
    session["items"].append(item)

    preview_data = render_preview_image(
        Path(session["pdf_path"]), item["page"], session["items"], zoom=session["zoom"]
    )
    return jsonify({
        "current_page": item["page"],
        "page_count": session["page_count"],
        "items_count": len(session["items"]),
        "lines_count": len(item["lines"]),
        **preview_data,
    })

@app.route("/undo", methods=["POST"])
def undo():
    data = get_request_json()
    session = get_session(data.get("session_id"))
    if not session:
        return jsonify({"error": "PDFを開き直してください。"}), 404

    page_index = int(data.get("page", 0))
    if session["items"]:
        session["items"].pop()

    preview_data = render_preview_image(
        Path(session["pdf_path"]), page_index, session["items"], zoom=session["zoom"]
    )
    return jsonify({
        "current_page": page_index,
        "page_count": session["page_count"],
        "items_count": len(session["items"]),
        **preview_data,
    })

@app.route("/clear", methods=["POST"])
def clear():
    data = get_request_json()
    session = get_session(data.get("session_id"))
    if not session:
        return jsonify({"error": "PDFを開き直してください。"}), 404

    page_index = int(data.get("page", 0))
    session["items"] = []

    preview_data = render_preview_image(
        Path(session["pdf_path"]), page_index, session["items"], zoom=session["zoom"]
    )
    return jsonify({
        "current_page": page_index,
        "page_count": session["page_count"],
        "items_count": 0,
        **preview_data,
    })

@app.route("/export", methods=["POST"])
def export_pdf():
    cleanup_expired_resources()

    data = get_request_json()
    session_id = data.get("session_id")
    session = get_session(session_id)
    if not session:
        return jsonify({"error": "PDFを開き直してください。"}), 404

    out_path = OUTPUT_DIR / f"direct_result_{session_id}.pdf"
    doc = None
    try:
        doc = fitz.open(session["pdf_path"])

        for item in session["items"]:
            draw_item_to_pdf_page(doc[item["page"]], item)

        doc.save(str(out_path))
    except Exception:
        remove_file_safely(out_path)
        return json_error("PDFを出力できませんでした。PDFを開き直して再度お試しください。", 500)
    finally:
        if doc is not None:
            doc.close()

    return jsonify({"download_url": f"/download/{out_path.name}"})

@app.route("/download/<filename>")
def download(filename):
    file_path = resolve_download_path(filename)
    if file_path is None:
        return json_error("ダウンロードファイルが見つかりません。", 404)

    response = make_response(
        send_file(
            file_path,
            as_attachment=True,
            download_name="direct_result_web.pdf",
            mimetype="application/octet-stream",
            conditional=False,
            max_age=0,
        )
    )

    # Safari対策：PDFプレビューではなく、添付ファイルとして扱わせる意図を強める
    response.headers["Content-Disposition"] = 'attachment; filename="direct_result_web.pdf"'
    response.headers["Content-Type"] = "application/octet-stream"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"

    return response

if __name__ == "__main__":
    debug_enabled = os.environ.get("FLASK_DEBUG", "").lower() in {"1", "true", "yes", "on"}
    app.run(debug=debug_enabled)
