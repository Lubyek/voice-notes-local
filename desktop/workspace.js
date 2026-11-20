import { initAgenda } from "./agenda.js";
import { api, requestSummary } from "./local-recordings.js";
import { formatTime } from "./summary.js";
import { post } from "../docs/transport.js";
import { serviceOrigin } from "../docs/service-config.js";
import { newCode, seal } from "./share-crypto.js";

const desktop = window.desktopMeeting;
const $ = (id) => document.getElementById(id);
const date = new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "short" });
const speechLanguages = {
  multi: "Автоматически", ru: "Русский", en: "Английский", uk: "Украинский", fr: "Французский",
  de: "Немецкий", es: "Испанский", it: "Итальянский", pt: "Португальский", pl: "Польский",
  tr: "Турецкий", zh: "Китайский", ja: "Японский",
};
const summaryLanguages = {
  auto: "Автоматически", ru: "Русский", en: "Английский", de: "Немецкий", es: "Испанский",
  fr: "Французский", it: "Итальянский", ja: "Японский", uk: "Украинский", zh: "Китайский (упрощённый)",
};
const settingIds = {
  language: "language", detect: "detect", remind: "remind", autoJoin: "auto-join", adHocEvent: "ad-hoc-event",
  live: "live", autoSummary: "auto-summary", summaryLanguage: "summary-language",
  short: "short", keyPoints: "key-points", actionItems: "action-items",
};
const settingsKey = "peopledo:preferences";
const prefs = {
  language: "multi", detect: true, remind: true, autoJoin: false, adHocEvent: true, live: true,
  autoSummary: true, summaryLanguage: "auto", short: true, keyPoints: true, actionItems: true,
  ...JSON.parse(localStorage.getItem(settingsKey) || "{}"),
};

function node(tag, text = "", className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function action(text, handler) {
  const element = node("button", text);
  element.type = "button";
  element.onclick = handler;
  return element;
}

function dialog(id) {
  return new Promise((resolve) => {
    const element = $(id);
    element.returnValue = "";
    element.addEventListener("close", () => resolve(element.returnValue === "ok"), { once: true });
    element.showModal();
  });
}

function highlight(target, text, query) {
  if (!query) {
    target.textContent = text;
    return;
  }
  const haystack = text.toLocaleLowerCase();
  let cursor = 0;
  for (let index = haystack.indexOf(query); index !== -1; index = haystack.indexOf(query, cursor)) {
    target.append(text.slice(cursor, index), node("mark", text.slice(index, index + query.length)));
    cursor = index + query.length;
  }
  target.append(text.slice(cursor));
}

function transcriptMarkdown(entry) {
  return entry.segments?.length ? entry.segments.map(({ text, start }) => "[" + formatTime(start) + "] " + text).join("\n\n") : entry.text;
}

function summaryText(summary) {
  if (!summary) return "";
  const blocks = [];
  if (summary.short) blocks.push("Краткий итог\n\n" + summary.short);
  for (const [label, items] of [["Ключевые пункты", summary.keyPoints], ["Решения", summary.decisions], ["Задачи", summary.actionItems]]) {
    if (!items?.length) continue;
    blocks.push(label + "\n\n" + items.map((item) => "- " + (item.text ?? [item.task, item.owner, item.due].filter(Boolean).join(" · "))).join("\n"));
  }
  return blocks.join("\n\n");
}

function vttStamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60]
    .map((part) => String(part).padStart(2, "0")).join(":") + "." + String(ms % 1000).padStart(3, "0");
}

export function initWorkspace({ onStart }) {
  let library = [];
  let selected;
  let current;
  let renderedId;
  let renderedState;
  let transcriptRender;
  let summaryRender;
  let tab = "transcript";
  let view = "library";
  let filterTimer;
  let historyRequest = 0;
  let lastFinished;
  let inFlight = false;
  let sharing = false;

  function updateView(value) {
    view = value;
    for (const id of ["library", "agenda", "settings"]) $(id).hidden = id !== value;
    for (const button of document.querySelectorAll("[data-view]")) {
      button.setAttribute("aria-pressed", String(button.dataset.view === value));
    }
    if (value === "agenda") agenda.render();
  }

  function updateTab(value) {
    tab = value;
    for (const id of ["transcript", "summary", "notes"]) $(id + "-pane").hidden = id !== value;
    for (const button of document.querySelectorAll("[data-tab]")) {
      button.setAttribute("aria-pressed", String(button.dataset.tab === value));
    }
  }

  async function openEvent(event, join = false) {
    if (join) {
      if (!await desktop.openLink(event.link)) throw new Error("Не удалось открыть ссылку на встречу.");
      if (!prefs.autoJoin) return;
    }
    await onStart(event);
  }

  const agenda = initAgenda({
    desktop, getNotes: () => library, onOpenNote: (note) => { openEntry(note); updateView("library"); },
    onStart: (event, join) => openEvent(event, join).catch((error) => { $("agenda-status").textContent = error.message; }),
  });

  function openEntry(entry) {
    selected = entry;
    renderEntry();
    markHistory();
  }

  function markHistory() {
    for (const button of $("history-list").querySelectorAll("button")) {
      button.setAttribute("aria-current", String(button.dataset.id === selected?.id));
    }
  }

  async function loadHistory() {
    const request = ++historyRequest;
    const query = $("history-search").value.trim();
    const { items } = await api("/recordings");
    if (request !== historyRequest) return;
    library = items;
    const q = query.toLocaleLowerCase();
    const shown = q ? (await api("/recordings?q=" + encodeURIComponent(q))).items : items;
    if (request !== historyRequest) return;
    const list = $("history-list");
    list.replaceChildren();
    $("history-empty").hidden = shown.length > 0;
    $("history-empty").textContent = q ? "Совпадений нет." : "Здесь появятся сохранённые записи.";
    for (const entry of shown) {
      const row = node("li");
      const button = action("", () => openEntry(entry));
      button.dataset.id = entry.id;
      button.append(node("span", entry.title || "Расшифровка", "history-name"),
        node("span", date.format(new Date(entry.created_at)) + " · " + formatTime(entry.duration), "muted"),
        node("span", (entry.cleaned || entry.text || "").replace(/\s+/g, " "), "history-preview"));
      row.append(button);
      list.append(row);
    }
    markHistory();
    if (view === "agenda") agenda.render();
  }

  function renderTranscript(entry) {
    const list = $("transcript-lines");
    const query = $("transcript-search").value.trim().toLocaleLowerCase();
    const polished = $("cleaned-toggle").checked && entry.cleaned;
    const key = JSON.stringify([entry.id, entry.text, polished, query]);
    if (key === transcriptRender) return;
    transcriptRender = key;
    list.replaceChildren();
    const available = Boolean(polished || entry.text);
    if (polished) {
      if (!query || polished.toLocaleLowerCase().includes(query)) highlight(list, polished, query);
    } else {
      const parts = entry.segments?.length ? entry.segments : entry.text ? [{ start: 0, text: entry.text }] : [];
      for (const part of parts) {
        if (query && !part.text.toLocaleLowerCase().includes(query)) continue;
        const row = node("div", "", "transcript-line");
        row.dataset.time = part.start;
        const text = node("p");
        highlight(text, part.text, query);
        row.append(node("time", formatTime(part.start)), text);
        list.append(row);
      }
    }
    $("transcript-empty").hidden = list.childNodes.length > 0;
    $("transcript-empty").textContent = available ? "Совпадений нет." : "Текст появится после обработки звука.";
  }

  function jumpTo(time) {
    updateTab("transcript");
    $("transcript-search").value = "";
    $("cleaned-toggle").checked = false;
    renderTranscript(selected);
    const items = [...document.querySelectorAll(".transcript-line")];
    const nearest = items.reduce((best, element) =>
      Math.abs(Number(element.dataset.time) - time) < Math.abs(Number(best?.dataset.time ?? Infinity) - time) ? element : best, null);
    if (!nearest) return;
    for (const item of items) item.classList.toggle("current", item === nearest);
    nearest.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function renderSummary(entry) {
    const content = $("summary-content");
    const summary = entry.summary;
    $("summary-state").textContent = inFlight ? "DeepSeek составляет сводку…"
      : entry.summaryError || (summary ? "" : "Сводка для этой записи ещё не создана.");
    $("regenerate").textContent = summary ? "Сформировать заново" : "Сформировать сводку";
    $("edit-summary").hidden = !summary || entry.id === current?.id;
    $("regenerate").disabled = inFlight || !entry.text || entry.id === current?.id;
    const key = JSON.stringify([entry.id, summary]);
    if (summaryRender === key) return;
    summaryRender = key;
    content.replaceChildren();
    if (!summary) return;
    if (summary.short) content.append(section("Краткий итог", node("p", summary.short)));
    for (const [label, items] of [["Ключевые пункты", summary.keyPoints], ["Решения", summary.decisions], ["Задачи", summary.actionItems]]) {
      if (!items?.length) continue;
      const list = node("ul");
      for (const item of items) {
        const row = node("li", item.text ?? item.task);
        const extra = [item.owner, item.due].filter(Boolean).join(" · ");
        if (extra) row.append(node("span", " · " + extra, "muted"));
        if (Number.isFinite(item.time)) {
          const link = action(formatTime(item.time), () => jumpTo(item.time));
          link.className = "jump";
          row.append(link);
        }
        list.append(row);
      }
      content.append(section(label, list));
    }
    if (!content.children.length) content.append(node("p", "В выбранных разделах нет данных.", "muted"));
  }

  function section(label, body) {
    const wrapper = node("div", "", "summary-section");
    wrapper.append(node("h2", label), body);
    return wrapper;
  }

  function renderEntry() {
    const entry = selected;
    $("entry-empty").hidden = Boolean(entry);
    $("entry-content").hidden = !entry;
    if (!entry) return;
    const isCurrent = entry.id === current?.id;
    const changed = renderedId !== entry.id;
    const finished = renderedState === "processing" && !isCurrent;
    renderedId = entry.id;
    renderedState = entry.status;
    if (changed) {
      $("transcript-search").value = "";
      $("cleaned-toggle").checked = false;
      $("entry-status").textContent = "";
      updateTab("transcript");
    }
    if (changed || finished) {
      $("note-text").value = entry.notes || "";
    }
    const kind = entry.kind === "meeting" ? "Встреча" : "Личная запись";
    const metadata = [entry.title === kind ? "" : kind, date.format(new Date(entry.created_at)), formatTime(entry.duration)].filter(Boolean);
    $("entry-title").textContent = entry.title || "Расшифровка";
    $("entry-meta").textContent = metadata.join(" · ");
    for (const id of ["rename", "delete-note", "note-text", "save-notes", "share-note"]) $(id).disabled = isCurrent;
    $("cleaned-toggle").disabled = !entry.cleaned;
    $("copy-note").disabled = !entry.text && !entry.notes;
    $("current-note").hidden = !current || isCurrent;
    renderTranscript(entry);
    renderSummary(entry);
  }

  async function edit(entry, data) {
    const updated = await api("/recordings/" + entry.id + "/edit", { method: "POST", json: data });
    if (selected?.id === updated.id) openEntry(updated);
    await loadHistory();
  }

  function report(error, id = "entry-status") {
    $(id).textContent = error.message || "Действие не удалось.";
  }

  $("history-search").oninput = () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => void loadHistory().catch(report), 130);
  };
  $("transcript-search").oninput = $("cleaned-toggle").onchange = () => renderTranscript(selected);
  $("current-note").onclick = () => openEntry(current);
  $("rename").onclick = async () => {
    const entry = selected;
    $("name-input").value = entry.title;
    if (!await dialog("name-dialog")) return;
    const title = $("name-input").value.trim();
    if (title) await edit(entry, { title }).catch(report);
  };
  $("delete-note").onclick = async () => {
    const entry = selected;
    if (!await dialog("delete-dialog")) return;
    try {
      if (activeShare(entry)) await revoke(entry);
      await api("/recordings/" + entry.id + "/delete", { method: "POST" });
      selected = undefined;
      await loadHistory();
      openEntry(current || library[0]);
    } catch (error) { report(error); }
  };
  $("save-notes").onclick = async () => {
    try {
      await edit(selected, { notes: $("note-text").value.trim().slice(0, 60_000) });
      $("entry-status").textContent = "Заметки сохранены.";
    } catch (error) { report(error); }
  };
  $("regenerate").onclick = async () => {
    const entry = selected;
    inFlight = true;
    renderSummary(entry);
    try {
      const summary = await requestSummary(entry, prefs);
      await edit(entry, { summary, summaryError: "" });
    } catch (error) { report(error); }
    finally {
      inFlight = false;
      if (selected) renderSummary(selected);
    }
  };
  $("edit-summary").onclick = async () => {
    const entry = selected;
    const { summary } = entry;
    $("edit-short").value = summary.short || "";
    $("edit-points").value = summary.keyPoints.map(({ text }) => text).join("\n");
    $("edit-decisions").value = summary.decisions.map(({ text }) => text).join("\n");
    $("edit-tasks").value = summary.actionItems.map(({ task, owner, due }) => [task, owner, due].join(" | ")).join("\n");
    if (!await dialog("summary-dialog")) return;
    const rows = (id) => $(id).value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 100);
    const textRows = (id, previous) => rows(id).map((text) => previous.find((item) => item.text === text) || { text });
    const taskRows = rows("edit-tasks").map((line) => {
      const [task, owner = "", due = ""] = line.split("|").map((part) => part.trim());
      return { task, owner, due, time: summary.actionItems.find((item) => item.task === task)?.time };
    }).filter(({ task }) => task);
    await edit(entry, { summary: {
      short: $("edit-short").value.trim().slice(0, 20_000),
      keyPoints: textRows("edit-points", summary.keyPoints), decisions: textRows("edit-decisions", summary.decisions), actionItems: taskRows,
    } }).catch(report);
  };

  function exportText(entry, markdown = false) {
    const sections = [entry.title || "PeopleDo", date.format(new Date(entry.created_at))];
    const add = (title, text) => { if (text) sections.push((markdown ? "## " : "") + title + "\n\n" + text); };
    if (markdown) sections[0] = "# " + sections[0];
    if ($("share-summary").checked) add("ИИ-сводка", summaryText(entry.summary));
    if ($("share-transcript").checked) add("Расшифровка", transcriptMarkdown(entry));
    if ($("share-private").checked) add("Личные заметки", entry.notes);
    if (sections.length < 3) throw new Error("Выбери хотя бы один непустой раздел.");
    return sections.join("\n\n");
  }

  $("copy-note").onclick = async () => {
    const entry = selected;
    const text = tab === "notes" ? $("note-text").value : tab === "summary" ? summaryText(entry.summary)
      : $("cleaned-toggle").checked ? entry.cleaned : transcriptMarkdown(entry);
    if (!text) return;
    await desktop.copy(text);
    $("entry-status").textContent = "Скопировано.";
  };
  function activeShare(entry) {
    return entry.share?.expiresAt > Date.now() ? entry.share : null;
  }

  async function shareRequest(path, payload) {
    return (await post("/shares/" + path, JSON.stringify(payload), "application/json", 27_000)).json();
  }

  async function revoke(entry) {
    const published = activeShare(entry);
    if (!published) return;
    await shareRequest("revoke", { id: published.id, token: published.token });
    await edit(entry, { share: null });
  }

  function renderShare() {
    const published = activeShare(selected);
    $("publish-share").textContent = published ? "Копировать ссылку" : "Создать ссылку";
    $("publish-share").disabled = sharing;
    $("share-protected").disabled = sharing || Boolean(published);
    $("copy-access").hidden = !published?.protected;
    $("revoke-share").hidden = !published;
    $("revoke-share").disabled = sharing;
  }

  $("share-note").onclick = () => {
    $("share-status").textContent = activeShare(selected)
      ? "Ссылка содержит сохранённую копию и доступна 30 дней." : "Ссылка открывает зашифрованную копию заметки.";
    $("share-protected").checked = activeShare(selected)?.protected === true;
    renderShare();
    $("share-private").checked = false;
    $("share-summary").checked = Boolean(selected.summary);
    $("share-transcript").checked = Boolean(selected.text);
    $("save-vtt").disabled = !selected.segments?.length;
    void dialog("share-dialog");
  };
  $("publish-share").onclick = async () => {
    const entry = selected;
    sharing = true;
    renderShare();
    try {
      let published = activeShare(entry);
      if (!published) {
        const code = newCode();
        const token = newCode();
        const envelope = await seal(exportText(entry), code);
        if (envelope.data.length > 540_000) throw new Error("Заметка слишком длинная для ссылки. Можно сохранить её файлом.");
        const { id, expiresAt } = await shareRequest("create", { token, envelope });
        published = { id, expiresAt, code, token, protected: $("share-protected").checked };
        try { await edit(entry, { share: published }); }
        catch (error) {
          await shareRequest("revoke", { id, token });
          throw error;
        }
      }
      const url = new URL("/note/" + published.id, serviceOrigin);
      if (!published.protected) url.hash = published.code;
      await desktop.copy(url.href);
      $("share-status").textContent = published.protected
        ? "Ссылка скопирована. Передай код доступа получателю отдельно." : "Ссылка скопирована. Её может открыть любой получатель.";
    } catch (error) { report(error, "share-status"); }
    finally { sharing = false; renderShare(); }
  };
  $("copy-access").onclick = async () => {
    const published = activeShare(selected);
    if (!published?.protected) return;
    await desktop.copy(published.code);
    $("share-status").textContent = "Код доступа скопирован.";
  };
  $("revoke-share").onclick = async () => {
    sharing = true;
    renderShare();
    try {
      await revoke(selected);
      $("share-status").textContent = "Ссылка отозвана. Обновление доступа может занять до минуты.";
    } catch (error) { report(error, "share-status"); }
    finally { sharing = false; renderShare(); }
  };
  $("share-email").onclick = async () => {
    try {
      const text = exportText(selected);
      if (!await desktop.draftEmail({ title: selected.title, text })) {
        throw new Error("Текст слишком длинный для почтового черновика. Его можно скопировать или сохранить файлом.");
      }
    } catch (error) { report(error, "share-status"); }
  };
  $("share-copy").onclick = async () => {
    try {
      await desktop.copy(exportText(selected));
      $("share-status").textContent = "Материалы скопированы.";
    } catch (error) { report(error, "share-status"); }
  };
  for (const extension of ["txt", "md", "vtt"]) $("save-" + extension).onclick = async () => {
    const entry = selected;
    try {
      const body = extension === "vtt" ? "WEBVTT\n\n" + entry.segments.map(({ start, end, text }) =>
        vttStamp(start) + " --> " + vttStamp(Math.max(end, start + 0.05)) + "\n" + text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")).join("\n\n")
        : exportText(entry, extension === "md");
      if (await desktop.saveFile({ extension, name: entry.title || "PeopleDo", body })) $("share-status").textContent = "Файл сохранён.";
    } catch (error) { report(error, "share-status"); }
  };

  for (const [id, languages] of [["language", speechLanguages], ["summary-language", summaryLanguages]]) {
    for (const [value, label] of Object.entries(languages)) $(id).append(new Option(label, value));
  }
  for (const [key, id] of Object.entries(settingIds)) {
    const input = $(id);
    const checkbox = input.type === "checkbox";
    if (checkbox) input.checked = prefs[key];
    else input.value = prefs[key];
    input.onchange = () => {
      prefs[key] = checkbox ? input.checked : input.value;
      localStorage.setItem(settingsKey, JSON.stringify(prefs));
      desktop.setPreferences({ detect: prefs.detect, remind: prefs.remind });
    };
  }
  desktop.setPreferences({ detect: prefs.detect, remind: prefs.remind });
  for (const button of document.querySelectorAll("[data-view]")) button.onclick = () => updateView(button.dataset.view);
  for (const button of document.querySelectorAll("[data-tab]")) button.onclick = () => updateTab(button.dataset.tab);
  void loadHistory().then(() => { if (!selected) openEntry(library[0]); }).catch(report);

  return {
    getOptions: () => ({ ...prefs }),
    openEvent,
    update({ active, last }) {
      const previous = current;
      current = active;
      if (active && !previous) {
        openEntry(active);
        updateView("library");
      } else if (previous?.id && selected?.id === previous.id) {
        selected = current || last;
        renderEntry();
      }
      if (last?.id && lastFinished !== last.id) {
        lastFinished = last.id;
        if (last.text && prefs.adHocEvent) agenda.addPast(last);
        void loadHistory().catch(report);
      }
    },
  };
}
