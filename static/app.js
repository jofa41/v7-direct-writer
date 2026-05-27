let sessionId = null;
let currentPage = 0;
let pageCount = 0;
let zoom = 1.5;
let pageWidth = 0;

let pendingItem = null;
let lastClick = null;
let hoverPoint = null;
let mode = "idle";

const pdfFile = document.getElementById("pdfFile");
const pdfImage = document.getElementById("pdfImage");
const markerCanvas = document.getElementById("markerCanvas");
const viewer = document.getElementById("viewer");
const statusEl = document.getElementById("status");
const floatingGuide = document.getElementById("floatingGuide");

const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const undoBtn = document.getElementById("undoBtn");
const cancelBtn = document.getElementById("cancelBtn");
const clearBtn = document.getElementById("clearBtn");
const exportBtn = document.getElementById("exportBtn");

function setStatus(text) { statusEl.textContent = text; }
function showFloatingGuide(text) { floatingGuide.textContent = text; floatingGuide.classList.remove("hidden"); }
function hideFloatingGuide() { floatingGuide.classList.add("hidden"); }

function isValidFontSize(value) {
  return /^[0-9]+(\.[0-9]+)?$/.test(value) && Number(value) > 0 && Number(value) <= 72;
}

function enableButtons() {
  prevBtn.disabled = !sessionId || currentPage <= 0 || mode === "waiting_end";
  nextBtn.disabled = !sessionId || currentPage >= pageCount - 1 || mode === "waiting_end";
  undoBtn.disabled = !sessionId || mode === "waiting_end";
  cancelBtn.disabled = mode !== "waiting_end";
  clearBtn.disabled = !sessionId || mode === "waiting_end";
  exportBtn.disabled = !sessionId || mode === "waiting_end";
}

function updatePreview(data) {
  pdfImage.src = data.image;
  currentPage = data.current_page ?? currentPage;
  pageCount = data.page_count ?? pageCount;
  zoom = data.zoom ?? zoom;
  pageWidth = data.page_width ?? pageWidth;

  pdfImage.onload = () => {
    markerCanvas.width = pdfImage.naturalWidth;
    markerCanvas.height = pdfImage.naturalHeight;
    markerCanvas.style.width = pdfImage.naturalWidth + "px";
    markerCanvas.style.height = pdfImage.naturalHeight + "px";
    viewer.style.width = pdfImage.naturalWidth + "px";
    viewer.style.height = pdfImage.naturalHeight + "px";
    drawMarkers();
  };

  enableButtons();
  if (mode !== "waiting_end") {
    hideFloatingGuide();
    setStatus(`${currentPage + 1}ページ目 / 全${pageCount}ページ`);
  }
}

function drawCross(ctx, x, y, color="red") {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y);
  ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
  ctx.stroke();
}

function drawMarkers() {
  const ctx = markerCanvas.getContext("2d");
  ctx.clearRect(0, 0, markerCanvas.width, markerCanvas.height);

  if (lastClick && lastClick.page === currentPage) {
    drawCross(ctx, lastClick.x * zoom, lastClick.y * zoom);
  }

  if (pendingItem && pendingItem.page === currentPage) {
    const x = pendingItem.x * zoom;
    const y = pendingItem.y * zoom;
    drawCross(ctx, x, y);

    // 開始位置から現在マウス位置、またはページ右端までガイド線
    const guideEndX = hoverPoint && hoverPoint.page === currentPage
      ? Math.max(hoverPoint.x * zoom, x + 2)
      : markerCanvas.width;

    ctx.strokeStyle = "rgba(30, 64, 175, 0.9)";
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(guideEndX, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 終点候補の縦線
    if (hoverPoint && hoverPoint.page === currentPage) {
      ctx.strokeStyle = "rgba(30, 64, 175, 0.45)";
      ctx.beginPath();
      ctx.moveTo(guideEndX, y - 14);
      ctx.lineTo(guideEndX, y + 14);
      ctx.stroke();
    }
  }
}

function getPdfPointFromClick(event) {
  const rect = pdfImage.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / zoom,
    y: (event.clientY - rect.top) / zoom
  };
}

function resetPending() {
  pendingItem = null;
  hoverPoint = null;
  mode = "idle";
  hideFloatingGuide();
  enableButtons();
  drawMarkers();
  setStatus(`${currentPage + 1}ページ目 / 全${pageCount}ページ`);
}

async function commitPendingWithWidth(wrapWidth) {
  if (!pendingItem) return;

  // 最小幅判定を20ptから5ptに緩和
  if (wrapWidth < 5) {
    alert("折返し右端は、開始位置より少し右側をクリックしてください。");
    return;
  }

  hideFloatingGuide();
  setStatus("文字を追加しています...");

  const res = await fetch("/add_text", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      session_id: sessionId,
      page: pendingItem.page,
      text: pendingItem.text,
      x: pendingItem.x,
      y: pendingItem.y,
      font_size: pendingItem.font_size,
      wrap_width: wrapWidth
    })
  });

  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }

  lastClick = { page: pendingItem.page, x: pendingItem.x, y: pendingItem.y };
  pendingItem = null;
  hoverPoint = null;
  mode = "idle";
  updatePreview(data);
}

pdfFile.addEventListener("change", async () => {
  const file = pdfFile.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("pdf", file);
  setStatus("PDFを開いています...");

  const res = await fetch("/upload", { method: "POST", body: formData });
  const data = await res.json();

  if (data.error) {
    alert(data.error);
    setStatus("PDFを開けませんでした");
    return;
  }

  sessionId = data.session_id;
  currentPage = data.current_page;
  pageCount = data.page_count;
  pendingItem = null;
  hoverPoint = null;
  lastClick = null;
  mode = "idle";
  updatePreview(data);
});

async function loadPage(page) {
  const res = await fetch("/preview", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ session_id: sessionId, page })
  });

  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  pendingItem = null;
  hoverPoint = null;
  lastClick = null;
  mode = "idle";
  updatePreview(data);
}

prevBtn.addEventListener("click", () => { if (currentPage > 0) loadPage(currentPage - 1); });
nextBtn.addEventListener("click", () => { if (currentPage < pageCount - 1) loadPage(currentPage + 1); });

pdfImage.addEventListener("mousemove", (event) => {
  if (mode !== "waiting_end" || !pendingItem) return;
  const point = getPdfPointFromClick(event);
  hoverPoint = { page: currentPage, x: point.x, y: point.y };
  drawMarkers();
});

pdfImage.addEventListener("click", async (event) => {
  if (!sessionId) return;
  const point = getPdfPointFromClick(event);

  if (mode === "idle") {
    const text = prompt("この位置に書き込む文字を入力してください");
    if (!text) return;

    let fontSize = null;

    while (fontSize === null) {
      const rawFontSize = prompt("文字サイズを半角数字で入力してください", "10");

      // キャンセル時は、開始位置・文字入力も含めて今回の追加を中止
      if (rawFontSize === null) return;

      const trimmed = rawFontSize.trim();

      if (isValidFontSize(trimmed)) {
        fontSize = parseFloat(trimmed);
      } else {
        alert("文字サイズは半角数字で入力してください。\n例：10");
        // ここで最初に戻らず、文字サイズ入力だけを再表示する
      }
    }

    pendingItem = {
      page: currentPage,
      text,
      x: point.x,
      y: point.y,
      font_size: fontSize
    };

    lastClick = { page: currentPage, x: point.x, y: point.y };
    hoverPoint = null;
    mode = "waiting_end";

    drawMarkers();
    enableButtons();
    showFloatingGuide("折返し右端をクリックしてください\nEnter：ページ右端　Esc：キャンセル");
    setStatus("折返し右端待機中（Enterでページ右端／Escでキャンセル）");
    return;
  }

  if (mode === "waiting_end" && pendingItem) {
    await commitPendingWithWidth(point.x - pendingItem.x);
  }
});

document.addEventListener("keydown", async (event) => {
  if (mode !== "waiting_end" || !pendingItem) return;

  if (event.key === "Enter") {
    event.preventDefault();
    // Enter時は現在位置からページ右端までを折返し幅にする
    await commitPendingWithWidth(pageWidth - pendingItem.x);
  }

  if (event.key === "Escape") {
    event.preventDefault();
    resetPending();
    setStatus("入力をキャンセルしました");
  }
});

cancelBtn.addEventListener("click", () => {
  resetPending();
  setStatus("入力をキャンセルしました");
});

undoBtn.addEventListener("click", async () => {
  const res = await fetch("/undo", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ session_id: sessionId, page: currentPage })
  });

  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  pendingItem = null;
  hoverPoint = null;
  lastClick = null;
  mode = "idle";
  updatePreview(data);
});

clearBtn.addEventListener("click", async () => {
  if (!confirm("入力済みの文字をすべて削除しますか？")) return;

  const res = await fetch("/clear", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ session_id: sessionId, page: currentPage })
  });

  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  pendingItem = null;
  hoverPoint = null;
  lastClick = null;
  mode = "idle";
  updatePreview(data);
});

exportBtn.addEventListener("click", async () => {
  setStatus("PDFを出力しています...");

  const res = await fetch("/export", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ session_id: sessionId })
  });

  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  window.location.href = data.download_url;
  setStatus("PDFを出力しました");
});
