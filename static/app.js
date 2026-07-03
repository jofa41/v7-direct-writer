let sessionId = null;
let currentPage = 0;
let pageCount = 0;
let zoom = 1.5;
let pageWidth = 0;

let pendingItem = null;
let lastClick = null;
let hoverPoint = null;
let pageItems = [];
let selectedItemId = null;
let mode = "idle";
let activeNudge = null;

const NUDGE_REPEAT_DELAY_MS = 250;
const NUDGE_REPEAT_INTERVAL_MS = 80;
const NUDGE_REPEAT_STEP = 6;

const pdfFile = document.getElementById("pdfFile");
const pdfImage = document.getElementById("pdfImage");
const markerCanvas = document.getElementById("markerCanvas");
const viewer = document.getElementById("viewer");
const statusEl = document.getElementById("status");
const floatingGuide = document.getElementById("floatingGuide");

const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const undoBtn = document.getElementById("undoBtn");
const editItemBtn = document.getElementById("editItemBtn");
const deleteItemBtn = document.getElementById("deleteItemBtn");
const nudgeButtons = Array.from(document.querySelectorAll(".nudgeBtn"));
const cancelBtn = document.getElementById("cancelBtn");
const clearBtn = document.getElementById("clearBtn");
const exportBtn = document.getElementById("exportBtn");

function setStatus(text) { statusEl.textContent = text; }
function showFloatingGuide(text) { floatingGuide.textContent = text; floatingGuide.classList.remove("hidden"); }
function hideFloatingGuide() { floatingGuide.classList.add("hidden"); }

function getSelectedItem() {
  return pageItems.find(item => item.item_id === selectedItemId) || null;
}

function summarizeText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "空の項目";
  return normalized.length > 16 ? normalized.slice(0, 16) + "..." : normalized;
}

function setIdleStatus() {
  const selectedItem = getSelectedItem();
  if (selectedItem) {
    setStatus(`選択中: ${summarizeText(selectedItem.text)}`);
  } else {
    setStatus(`${currentPage + 1}ページ目 / 全${pageCount}ページ`);
  }
}

function normalizeFontSizeInput(value) {
  return String(value || "")
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, ".")
    .trim();
}

function validateFontSizeInput(value) {
  const normalized = normalizeFontSizeInput(value);
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(normalized)) {
    return { error: "文字サイズは数字で入力してください。" };
  }

  const fontSize = Number(normalized);
  if (fontSize < 1 || fontSize > 72) {
    return { error: "文字サイズは1〜72の範囲で入力してください。" };
  }

  return { value: fontSize };
}

function enableButtons() {
  prevBtn.disabled = !sessionId || currentPage <= 0 || mode === "waiting_end";
  nextBtn.disabled = !sessionId || currentPage >= pageCount - 1 || mode === "waiting_end";
  undoBtn.disabled = !sessionId || mode === "waiting_end";
  const selectedActionDisabled = !sessionId || !selectedItemId || mode === "waiting_end";
  editItemBtn.disabled = selectedActionDisabled;
  deleteItemBtn.disabled = selectedActionDisabled;
  nudgeButtons.forEach(button => { button.disabled = selectedActionDisabled; });
  cancelBtn.disabled = mode !== "waiting_end";
  clearBtn.disabled = !sessionId || mode === "waiting_end";
  exportBtn.disabled = !sessionId || mode === "waiting_end";
}

async function refreshCurrentPreview() {
  if (!sessionId) return false;

  let data;
  try {
    const res = await fetch("/preview", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ session_id: sessionId, page: currentPage })
    });
    data = await res.json();
  } catch (error) {
    alert("プレビューを更新できませんでした。時間をおいて再度お試しください。");
    return false;
  }

  if (data.error) { alert(data.error); return false; }

  updatePreview(data);
  return true;
}

function updateItemsOnly(data) {
  currentPage = data.current_page ?? currentPage;
  pageCount = data.page_count ?? pageCount;
  pageItems = Array.isArray(data.items) ? data.items : [];

  if (data.moved_item_id) {
    selectedItemId = data.moved_item_id;
  }
  if (selectedItemId && !pageItems.some(item => item.item_id === selectedItemId)) {
    selectedItemId = null;
    stopNudgeRepeat({ finalize: false });
  }

  drawMarkers();
  enableButtons();
}

function updatePreview(data) {
  pdfImage.src = data.image;
  currentPage = data.current_page ?? currentPage;
  pageCount = data.page_count ?? pageCount;
  zoom = data.zoom ?? zoom;
  pageWidth = data.page_width ?? pageWidth;
  pageItems = Array.isArray(data.items) ? data.items : [];

  if (data.created_item_id) {
    selectedItemId = data.created_item_id;
  }
  if (selectedItemId && !pageItems.some(item => item.item_id === selectedItemId)) {
    selectedItemId = null;
    stopNudgeRepeat({ finalize: false });
  }

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
    setIdleStatus();
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

function getItemBounds(item) {
  if (item.bounds) return item.bounds;
  const lineCount = Array.isArray(item.lines) && item.lines.length ? item.lines.length : 1;
  return {
    x: item.x,
    y: item.y - item.font_size,
    width: Math.max(item.wrap_width || 0, item.font_size || 10),
    height: lineCount * (item.font_size || 10) * 1.25
  };
}

function drawSelectedItem(ctx) {
  const selectedItem = getSelectedItem();
  if (!selectedItem || selectedItem.page !== currentPage) return;

  const bounds = getItemBounds(selectedItem);
  const padding = Math.max(4, (selectedItem.font_size || 10) * 0.35);
  const x = (bounds.x - padding) * zoom;
  const y = (bounds.y - padding) * zoom;
  const width = (bounds.width + padding * 2) * zoom;
  const height = (bounds.height + padding * 2) * zoom;

  ctx.save();
  ctx.fillStyle = "rgba(14, 165, 233, 0.08)";
  ctx.strokeStyle = "rgba(14, 116, 144, 0.95)";
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 4]);
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

function hitTestItem(point) {
  for (let i = pageItems.length - 1; i >= 0; i--) {
    const item = pageItems[i];
    if (item.page !== currentPage) continue;

    const bounds = getItemBounds(item);
    const padding = Math.max(8, (item.font_size || 10) * 0.8);
    const left = bounds.x - padding;
    const top = bounds.y - padding;
    const right = bounds.x + bounds.width + padding;
    const bottom = bounds.y + bounds.height + padding;

    if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) {
      return item;
    }
  }
  return null;
}

function drawMarkers() {
  const ctx = markerCanvas.getContext("2d");
  ctx.clearRect(0, 0, markerCanvas.width, markerCanvas.height);

  if (lastClick && lastClick.page === currentPage) {
    drawCross(ctx, lastClick.x * zoom, lastClick.y * zoom);
  }

  drawSelectedItem(ctx);

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

function waitForPaint() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function resetPending() {
  pendingItem = null;
  hoverPoint = null;
  mode = "idle";
  hideFloatingGuide();
  enableButtons();
  drawMarkers();
  setIdleStatus();
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

async function startNewTextInput(point) {
  const text = prompt("この位置に書き込む文字を入力してください");
  if (!text) {
    drawMarkers();
    setIdleStatus();
    return;
  }

  let fontSize = null;

  while (fontSize === null) {
    const rawFontSize = prompt("文字サイズを数字で入力してください", "10");

    // キャンセル時は、開始位置・文字入力も含めて今回の追加を中止
    if (rawFontSize === null) return;

    const validation = validateFontSizeInput(rawFontSize);

    if (validation.error) {
      alert(validation.error);
      // ここで最初に戻らず、文字サイズ入力だけを再表示する
    } else {
      fontSize = validation.value;
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
  pageItems = [];
  selectedItemId = null;
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
  selectedItemId = null;
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
    const hitItem = hitTestItem(point);
    if (hitItem) {
      selectedItemId = hitItem.item_id;
      lastClick = null;
      drawMarkers();
      enableButtons();
      setIdleStatus();
      return;
    }

    const hadSelectedItem = selectedItemId !== null;
    selectedItemId = null;
    enableButtons();
    if (hadSelectedItem) {
      drawMarkers();
      setIdleStatus();
      await waitForPaint();
    }
    await startNewTextInput(point);
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
  if (selectedItemId && Array.isArray(data.items) && !data.items.some(item => item.item_id === selectedItemId)) {
    selectedItemId = null;
  }
  mode = "idle";
  updatePreview(data);
});

editItemBtn.addEventListener("click", async () => {
  if (!selectedItemId) {
    setStatus("編集する項目を選択してください");
    return;
  }

  const selectedItem = getSelectedItem();
  if (!selectedItem) {
    selectedItemId = null;
    enableButtons();
    setIdleStatus();
    return;
  }

  const text = prompt("選択項目の文字内容を編集してください", selectedItem.text || "");
  if (text === null) return;
  if (!text.trim()) {
    alert("文字内容を入力してください。");
    return;
  }

  let fontSize = null;
  while (fontSize === null) {
    const rawFontSize = prompt("選択項目の文字サイズを数字で入力してください", String(selectedItem.font_size || 10));
    if (rawFontSize === null) return;

    const validation = validateFontSizeInput(rawFontSize);
    if (validation.error) {
      alert(validation.error);
    } else {
      fontSize = validation.value;
    }
  }

  const res = await fetch("/update_item", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      session_id: sessionId,
      item_id: selectedItemId,
      text,
      font_size: fontSize,
      page: currentPage
    })
  });

  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  selectedItemId = data.updated_item_id || selectedItemId;
  pendingItem = null;
  hoverPoint = null;
  lastClick = null;
  mode = "idle";
  updatePreview(data);
  setStatus("選択項目を更新しました");
});

async function moveSelectedItem(dx, dy, options={}) {
  if (!selectedItemId) {
    setStatus("移動する項目を選択してください");
    return false;
  }

  const renderPreview = options.renderPreview !== false;
  let data;
  try {
    const res = await fetch("/move_item", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        session_id: sessionId,
        item_id: selectedItemId,
        dx,
        dy,
        page: currentPage,
        render_preview: renderPreview
      })
    });
    data = await res.json();
  } catch (error) {
    alert("選択項目を移動できませんでした。時間をおいて再度お試しください。");
    return false;
  }

  if (data.error) { alert(data.error); return false; }

  selectedItemId = data.moved_item_id || selectedItemId;
  pendingItem = null;
  hoverPoint = null;
  lastClick = null;
  mode = "idle";
  if (renderPreview) {
    updatePreview(data);
  } else {
    updateItemsOnly(data);
  }
  setStatus("選択項目を移動しました");
  return true;
}

function stopNudgeRepeat(options={}) {
  if (!activeNudge) return;
  const nudge = activeNudge;
  clearTimeout(nudge.timer);
  nudge.stopped = true;
  nudge.finalizeOnStop = options.finalize !== false;
  activeNudge = null;

  if (nudge.finalizeOnStop && !nudge.inFlight && nudge.needsPreview && selectedItemId) {
    refreshCurrentPreview();
  }
}

async function performNudgeStep(nudge, isRepeat=false) {
  if (!nudge || nudge.inFlight || !selectedItemId) {
    stopNudgeRepeat({ finalize: false });
    return false;
  }

  nudge.inFlight = true;
  const multiplier = isRepeat ? NUDGE_REPEAT_STEP : 1;
  const moved = await moveSelectedItem(
    nudge.dx * multiplier,
    nudge.dy * multiplier,
    { renderPreview: !isRepeat }
  );
  nudge.inFlight = false;

  if (moved && isRepeat) {
    nudge.needsPreview = true;
  }

  if (nudge.stopped) {
    if (nudge.finalizeOnStop && nudge.needsPreview && selectedItemId) {
      refreshCurrentPreview();
    }
    return false;
  }

  if (!moved || activeNudge !== nudge || !selectedItemId) {
    stopNudgeRepeat({ finalize: false });
    return false;
  }
  return true;
}

function scheduleNudgeRepeat(nudge, delay) {
  nudge.timer = setTimeout(async () => {
    if (await performNudgeStep(nudge, true)) {
      scheduleNudgeRepeat(nudge, NUDGE_REPEAT_INTERVAL_MS);
    }
  }, delay);
}

function startNudgeRepeat(button, event) {
  if (button.disabled) return;
  event.preventDefault();

  stopNudgeRepeat();
  const nudge = {
    dx: Number(button.dataset.nudgeDx),
    dy: Number(button.dataset.nudgeDy),
    timer: null,
    inFlight: false,
    needsPreview: false,
    stopped: false,
    finalizeOnStop: true
  };
  activeNudge = nudge;

  performNudgeStep(nudge).then(moved => {
    if (moved && activeNudge === nudge) {
      scheduleNudgeRepeat(nudge, NUDGE_REPEAT_DELAY_MS);
    }
  });
}

nudgeButtons.forEach(button => {
  button.addEventListener("pointerdown", event => {
    if (event.button !== undefined && event.button !== 0) return;
    startNudgeRepeat(button, event);
  });

  button.addEventListener("pointerleave", stopNudgeRepeat);
  button.addEventListener("pointercancel", stopNudgeRepeat);
  button.addEventListener("contextmenu", event => event.preventDefault());

  button.addEventListener("click", async event => {
    if (event.detail !== 0 || button.disabled) return;
    await moveSelectedItem(
      Number(button.dataset.nudgeDx),
      Number(button.dataset.nudgeDy)
    );
  });
});

document.addEventListener("pointerup", stopNudgeRepeat);
document.addEventListener("pointercancel", stopNudgeRepeat);
window.addEventListener("blur", stopNudgeRepeat);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopNudgeRepeat();
});

deleteItemBtn.addEventListener("click", async () => {
  if (!selectedItemId) {
    setStatus("削除する項目を選択してください");
    return;
  }

  const res = await fetch("/delete_item", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      session_id: sessionId,
      item_id: selectedItemId,
      page: currentPage
    })
  });

  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  stopNudgeRepeat({ finalize: false });
  selectedItemId = null;
  pendingItem = null;
  hoverPoint = null;
  lastClick = null;
  mode = "idle";
  updatePreview(data);
  setStatus("選択項目を削除しました");
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

  stopNudgeRepeat({ finalize: false });
  pendingItem = null;
  hoverPoint = null;
  lastClick = null;
  selectedItemId = null;
  mode = "idle";
  updatePreview(data);
});


function showExportToast(message) {
  let toast = document.getElementById("exportToast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "exportToast";
    toast.className = "exportToast";
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add("show");

  setTimeout(() => {
    toast.classList.remove("show");
  }, 6000);
}

function downloadFileWithoutLeaving(downloadUrl) {
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = "direct_result_web.pdf";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

exportBtn.addEventListener("click", async () => {
  setStatus("PDFを出力しています...");

  const res = await fetch("/export", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ session_id: sessionId })
  });

  const data = await res.json();
  if (data.error) { alert(data.error); return; }

  downloadFileWithoutLeaving(data.download_url);

  setStatus("PDFを出力しました。ダウンロードフォルダをご確認ください。");
  showExportToast("PDF出力完了。ダウンロードフォルダに保存されました。");
});
