import base64, uuid
from pathlib import Path
import fitz
from flask import Flask, render_template, request, jsonify, send_file, make_response

app = Flask(__name__)
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "output"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)
SESSIONS = {}

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
    page = doc[page_index]

    for item in items:
        if item["page"] == page_index:
            draw_item_to_pdf_page(page, item)

    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    png_bytes = pix.tobytes("png")

    data = {
        "image": "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii"),
        "page_width": page.rect.width,
        "page_height": page.rect.height,
        "zoom": zoom,
    }
    doc.close()
    return data

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/upload", methods=["POST"])
def upload_pdf():
    file = request.files.get("pdf")
    if not file:
        return jsonify({"error": "PDFファイルがありません。"}), 400
    if not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "PDFファイルを選択してください。"}), 400

    session_id = str(uuid.uuid4())
    pdf_path = UPLOAD_DIR / f"{session_id}.pdf"
    file.save(pdf_path)

    doc = fitz.open(str(pdf_path))
    page_count = len(doc)
    doc.close()

    SESSIONS[session_id] = {
        "pdf_path": str(pdf_path),
        "items": [],
        "page_count": page_count,
        "zoom": 1.5,
    }

    preview = render_preview_image(pdf_path, 0, [], zoom=1.5)
    return jsonify({
        "session_id": session_id,
        "page_count": page_count,
        "current_page": 0,
        "items_count": 0,
        **preview,
    })

@app.route("/preview", methods=["POST"])
def preview():
    data = request.get_json()
    session = SESSIONS.get(data.get("session_id"))
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
    data = request.get_json()
    session = SESSIONS.get(data.get("session_id"))
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
    data = request.get_json()
    session = SESSIONS.get(data.get("session_id"))
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
    data = request.get_json()
    session = SESSIONS.get(data.get("session_id"))
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
    data = request.get_json()
    session = SESSIONS.get(data.get("session_id"))
    if not session:
        return jsonify({"error": "PDFを開き直してください。"}), 404

    out_path = OUTPUT_DIR / f"direct_result_{data.get('session_id')}.pdf"
    doc = fitz.open(session["pdf_path"])

    for item in session["items"]:
        draw_item_to_pdf_page(doc[item["page"]], item)

    doc.save(str(out_path))
    doc.close()

    return jsonify({"download_url": f"/download/{out_path.name}"})

@app.route("/download/<filename>")
def download(filename):
    file_path = OUTPUT_DIR / filename

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
    app.run(debug=True)
