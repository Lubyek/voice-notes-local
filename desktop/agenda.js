const key = "peopledo:agenda";
const date = new Intl.DateTimeFormat("ru", { dateStyle: "medium", timeStyle: "short" });
const dateOf = (value) => Date.parse(value);

export function meetingLink(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export function events() {
  return JSON.parse(localStorage.getItem(key) || "[]");
}

function save(items, desktop) {
  const sorted = items.sort((a, b) => a.start - b.start);
  localStorage.setItem(key, JSON.stringify(sorted));
  desktop.setSchedule(sorted);
}

function textOf(value = "") {
  return value.replace(/\\([nN,;\\])/g, (_, char) => /n/i.test(char) ? "\n" : char);
}

function calendarDate(value, zone) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, min, sec, utc] = match;
  const nominal = Date.UTC(+year, +month - 1, +day, +hour, +min, +sec);
  if (utc) return nominal;
  if (!zone) return new Date(+year, +month - 1, +day, +hour, +min, +sec).getTime();
  try {
    const formatter = new Intl.DateTimeFormat("en", {
      timeZone: zone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    let instant = nominal;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const p = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, +value]));
      const interpretation = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      instant += nominal - interpretation;
    }
    return instant;
  } catch { return NaN; }
}

export function parseCalendar(source) {
  const items = [];
  let skipped = 0;
  const rows = source.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  let item;
  for (const line of rows) {
    if (line === "BEGIN:VEVENT") { item = {}; continue; }
    if (line === "END:VEVENT" && item) {
      if (Number.isFinite(item.start) && !item.recurring && !item.cancelled) {
        const link = item.url || meetingLink(item.description?.match(/https:\/\/[^\s<>"]+/)?.[0]);
        items.push({
          id: item.uid ? "ics:" + item.uid.slice(0, 240) : crypto.randomUUID(),
          title: item.title?.slice(0, 120) || "Встреча", start: item.start, link,
        });
      } else skipped += 1;
      item = null;
      continue;
    }
    if (!item) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const [name, ...params] = line.slice(0, colon).split(";");
    const value = line.slice(colon + 1);
    if (name === "SUMMARY") item.title = textOf(value).trim();
    if (name === "UID") item.uid = value;
    if (name === "URL") item.url = meetingLink(value);
    if (name === "DESCRIPTION") item.description = textOf(value);
    if (name === "DTSTART") item.start = calendarDate(value, params.find((part) => part.startsWith("TZID="))?.slice(5).replace(/^"|"$/g, ""));
    if (name === "RRULE" || name === "RDATE" || name === "RECURRENCE-ID") item.recurring = true;
    if (name === "STATUS" && value === "CANCELLED") item.cancelled = true;
  }
  return { items, skipped };
}

export function initAgenda({ desktop, onStart, onOpenNote, getNotes }) {
  const element = (id) => document.getElementById(id);
  const form = element("event-form");
  const file = element("agenda-file");
  const list = element("agenda-list");
  const status = element("agenda-status");
  const titleField = element("event-title");
  const timeField = element("event-time");
  const linkField = element("event-link");
  let editing = null;

  function button(text, handler) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = text;
    control.onclick = handler;
    return control;
  }

  function render() {
    const entries = events();
    const notes = getNotes();
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "В календаре пока нет встреч.";
      list.append(empty);
      return;
    }
    for (const event of entries) {
      const row = document.createElement("li");
      row.className = "agenda-row";
      const name = document.createElement("div");
      const title = document.createElement("h2");
      title.textContent = event.title;
      const time = document.createElement("p");
      time.className = "muted";
      time.textContent = date.format(event.start);
      name.append(title, time);
      const actions = document.createElement("div");
      actions.className = "actions";
      const note = notes.find(({ eventId }) => event.id === eventId)
        ?? notes.find(({ id }) => event.noteId === id);
      if (note) actions.append(button("Открыть запись", () => onOpenNote(note)));
      if (event.start >= Date.now() - 6 * 60 * 60 * 1000 || !note) {
        if (event.link) actions.append(button("Войти", () => onStart(event, true)));
        actions.append(button("Записать", () => onStart(event)));
      }
      if (!event.noteId) actions.append(button("Изменить", () => {
        editing = event.id;
        const when = new Date(event.start);
        titleField.value = event.title;
        timeField.value = new Date(event.start - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        linkField.value = event.link;
        form.querySelector('button[type="submit"]').textContent = "Сохранить встречу";
        titleField.focus();
      }));
      actions.append(button("Убрать", () => {
        save(events().filter(({ id }) => id !== event.id), desktop);
        if (editing === event.id) resetForm();
        render();
      }));
      row.append(name, actions);
      list.append(row);
    }
  }

  function resetForm() {
    editing = null;
    form.reset();
    form.querySelector('button[type="submit"]').textContent = "Добавить встречу";
  }

  form.onsubmit = (event) => {
    event.preventDefault();
    const title = titleField.value.trim();
    const start = dateOf(timeField.value);
    const link = meetingLink(linkField.value.trim());
    if (!title || !Number.isFinite(start) || (linkField.value && !link)) {
      status.textContent = "Проверь название, дату и HTTPS-ссылку.";
      return;
    }
    const id = editing || crypto.randomUUID();
    save([...events().filter((item) => item.id !== id), { id, title, start, link }], desktop);
    resetForm();
    status.textContent = "Встреча сохранена.";
    render();
  };
  element("import-agenda").onclick = () => file.click();
  file.onchange = async () => {
    const selected = file.files[0];
    file.value = "";
    if (!selected) return;
    if (selected.size > 5_000_000) {
      status.textContent = "Выбери файл календаря меньше 5 МБ.";
      return;
    }
    try {
      const { items, skipped } = parseCalendar(await selected.text());
      const merged = new Map(events().map((item) => [item.id, item]));
      for (const item of items) merged.set(item.id, item);
      save([...merged.values()], desktop);
      status.textContent = `Импортировано встреч: ${items.length}.` + (skipped ? ` Пропущено: ${skipped}.` : "");
      render();
    } catch {
      status.textContent = "Не удалось прочитать календарь.";
    }
  };

  desktop.setSchedule(events());
  render();
  return {
    render,
    addPast(note) {
      if (note.kind !== "meeting" || note.eventId) return;
      const items = events();
      if (items.some((item) => item.noteId === note.id)) return;
      save([...items, { id: note.id, noteId: note.id, title: note.title, start: dateOf(note.created_at), link: "" }], desktop);
      render();
    },
  };
}
