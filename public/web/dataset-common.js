/**
 * Общее для всех страниц разметки: вход, шапка, инструкция, подвал.
 *
 * Живёт одним файлом, потому что четыре страницы с четырьмя копиями одной
 * шапки расходятся через месяц, и расходятся молча.
 */

const TELEGRAM_CONTACT = "jj07n";

const DATASET_PAGES = [
  { href: "/web/dataset-tasks.html", label: "Записи", key: "tasks" },
  { href: "/web/dataset-export.html", label: "Выгрузка", key: "export", needs: "export" },
  { href: "/web/dataset-users.html", label: "Пользователи", key: "users", needs: "manageUsers" },
];

/** Умеет ли текущий пользователь то-то. Права приходят с сервера вместе с сессией. */
function iCan(capability) {
  return Boolean(state.me && state.me.can && state.me.can[capability]);
}

const state = { me: null };

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function show(el, visible) {
  if (el) el.classList.toggle("hidden", !visible);
}

function showError(el, message) {
  if (!el) return;
  if (!message) { show(el, false); return; }
  el.textContent = message;
  show(el, true);
}

/** Запрос к API. Слетевшая сессия возвращает на страницу входа, а не в тупик. */
async function api(path, options) {
  const opts = Object.assign({}, options || {});
  if (!(opts.body instanceof FormData)) {
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // На самой странице входа 401 означает «неверный пароль», а не «сессия
    // истекла»: редирект туда же стёр бы сообщение и выглядел как зависание.
    if (res.status === 401 && !location.pathname.endsWith("/dataset.html")) {
      location.href = "/web/dataset.html?next=" + encodeURIComponent(location.pathname + location.search);
      throw new Error("Нужен вход");
    }
    throw new Error(data.error || "Ошибка " + res.status);
  }
  return data;
}

async function fetchSession() {
  return fetch("/api/dataset/session")
    .then((r) => r.json())
    .catch(() => ({ authenticated: false }));
}

/**
 * Пускает на страницу только вошедших. Возвращает лингвиста, либо уводит на
 * вход — страница не должна успеть моргнуть содержимым, которого не покажет.
 */
async function requireSession() {
  const data = await fetchSession();
  if (!data.authenticated) {
    location.href = "/web/dataset.html?next=" + encodeURIComponent(location.pathname + location.search);
    return null;
  }
  state.me = data.annotator;
  return data.annotator;
}

// ---------------------------------------------------------------------------
// Шапка и подвал
// ---------------------------------------------------------------------------

/**
 * Правила, общие для всех страниц на телефоне.
 *
 * Живут в JS, а не в каждой странице: разъехавшиеся копии одного медиазапроса
 * ловить потом дороже, чем держать их в одном месте.
 */
function injectSharedStyles() {
  if ($("datasetSharedStyles")) return;

  const style = document.createElement("style");
  style.id = "datasetSharedStyles";
  style.textContent = `
    /* Свой значок вместо системного треугольника, иначе их будет два. */
    .help-section > summary::-webkit-details-marker { display: none; }
    .help-section > summary::marker { content: ""; }
    .help-section > summary { min-height: 2.75rem; }
    .help-section[open] > summary > span:last-child { transform: rotate(180deg); }
    .help-section > summary > span:last-child { transition: transform 0.15s; }

    @media (max-width: 640px) {
      /* Safari на iOS увеличивает страницу при фокусе в поле мельче 16px.
         Пользователь получает съехавшую вёрстку и ручной откат зума. */
      input, select, textarea { font-size: 16px !important; }

      /* Палец накрывает примерно 45px. Кнопка в 23px — это промах через раз. */
      .btn-xs, .btn-sm { min-height: 2.5rem; height: auto; padding-top: 0.4rem; padding-bottom: 0.4rem; }
      .ky-letter { min-width: 2.75rem; min-height: 2.75rem; font-size: 1.15rem; }
      .modal-box { max-height: 88vh; }
    }`;
  document.head.append(style);
}

function mountChrome(options) {
  injectSharedStyles();
  const opts = options || {};
  const active = opts.key;
  const me = state.me;

  // На странице входа навигация вела бы обратно на неё же.
  const nav = (opts.minimal ? [] : DATASET_PAGES)
    .filter((page) => !page.needs || iCan(page.needs))
    .map((page) => {
      const cls = page.key === active ? "btn btn-sm btn-primary" : "btn btn-sm btn-ghost";
      return `<a class="${cls}" href="${page.href}">${page.label}</a>`;
    })
    .join("");

  const header = document.createElement("header");
  header.className = "flex flex-wrap items-center justify-between gap-3 mb-6";
  header.innerHTML = `
    <div class="flex items-center gap-2 flex-wrap">
      <a href="/web/dataset-tasks.html" class="font-bold text-lg tracking-tight mr-2">Разметка аудио</a>
      ${nav}
    </div>
    <div class="flex items-center gap-2 flex-wrap">
      <button class="btn btn-sm btn-outline" id="helpBtn">Инструкция</button>
      ${me ? `<div class="dropdown dropdown-end">
        <button tabindex="0" class="btn btn-sm btn-ghost">
          ${escapeHtml(me.displayName)}
          <span class="badge badge-ghost badge-sm">${escapeHtml(me.roleName || "")}</span>
        </button>
        <ul tabindex="0" class="dropdown-content menu bg-base-100 rounded-box shadow-sm z-30 w-52 p-2">
          <li><button id="ownPasswordBtn">Сменить свой пароль</button></li>
          <li><button id="logoutBtn">Выйти</button></li>
        </ul>
      </div>` : ""}
    </div>`;

  const root = document.querySelector("main") || document.body;
  root.prepend(header);

  const footer = document.createElement("footer");
  footer.className = "mt-10 pt-6 border-t border-base-300 text-sm opacity-70 flex flex-wrap gap-2 items-center";
  footer.innerHTML = `
    <span>Не получается или что-то работает не так?</span>
    <a class="link link-primary" href="https://t.me/${TELEGRAM_CONTACT}" target="_blank" rel="noopener">
      Написать в Telegram @${TELEGRAM_CONTACT}
    </a>`;
  root.append(footer);

  mountHelpDialog();
  $("helpBtn").onclick = () => openHelp();

  const logout = $("logoutBtn");
  if (logout) {
    logout.onclick = async () => {
      await fetch("/api/dataset/logout", { method: "POST" });
      location.href = "/web/dataset.html";
    };
  }

  if (me) mountOwnPasswordDialog();
}

// ---------------------------------------------------------------------------
// Свой пароль
// ---------------------------------------------------------------------------

function mountOwnPasswordDialog() {
  if ($("ownPasswordDialog")) return;

  const dialog = document.createElement("dialog");
  dialog.id = "ownPasswordDialog";
  dialog.className = "modal";
  dialog.innerHTML = `
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-lg mb-3">Сменить свой пароль</h3>
      <div class="space-y-3">
        <input id="ownCurrentPass" type="password" class="input input-bordered w-full" placeholder="Текущий пароль" autocomplete="current-password">
        <input id="ownNewPass" type="password" class="input input-bordered w-full" placeholder="Новый пароль, от 8 символов" autocomplete="new-password">
        <div id="ownPassMsg" class="alert text-sm hidden"></div>
      </div>
      <div class="modal-action">
        <form method="dialog"><button class="btn btn-ghost">Отмена</button></form>
        <button class="btn btn-primary" id="ownPassSave">Сохранить</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>закрыть</button></form>`;
  document.body.append(dialog);

  const message = (text, ok) => {
    const box = $("ownPassMsg");
    box.className = "alert text-sm " + (ok ? "alert-success" : "alert-error");
    box.textContent = text;
    show(box, true);
  };

  $("ownPasswordBtn").onclick = () => {
    $("ownCurrentPass").value = "";
    $("ownNewPass").value = "";
    show($("ownPassMsg"), false);
    dialog.showModal();
  };

  $("ownPassSave").onclick = async () => {
    try {
      await api("/api/dataset/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: $("ownCurrentPass").value,
          password: $("ownNewPass").value,
        }),
      });
      message("Пароль изменён", true);
      setTimeout(() => dialog.close(), 1200);
    } catch (err) {
      message(err.message, false);
    }
  };
}

// ---------------------------------------------------------------------------
// Кыргызские буквы без кыргызской раскладки
// ---------------------------------------------------------------------------

/**
 * ө, ү, ң есть в кыргызском, но их нет в русской раскладке, а ставить вторую
 * раскладку ради трёх букв никто не будет. Без них лингвист напишет «о» вместо
 * «ө» — и модель выучит, что это один и тот же звук.
 *
 * Клавиша определяется по физической позиции (event.code), поэтому сочетание
 * работает одинаково и в русской раскладке, и в английской.
 */
const KYRGYZ_LETTERS = [
  { lower: "ө", upper: "Ө", code: "KeyO", key: "O" },
  { lower: "ү", upper: "Ү", code: "KeyU", key: "U" },
  { lower: "ң", upper: "Ң", code: "KeyN", key: "N" },
];

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.setRangeText(text, start, end, "end");
  // Автосохранение слушает input — без этого события правка не уедет на сервер.
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
}

function kyrgyzButtonsHtml() {
  const buttons = KYRGYZ_LETTERS.map(
    (letter) =>
      `<button type="button" class="btn btn-xs btn-outline ky-letter" data-letter="${letter.lower}"
        title="Alt + ${letter.key}">${letter.lower}</button>`
  ).join("");
  const upper = KYRGYZ_LETTERS.map(
    (letter) =>
      `<button type="button" class="btn btn-xs btn-ghost ky-letter" data-letter="${letter.upper}"
        title="Alt + Shift + ${letter.key}">${letter.upper}</button>`
  ).join("");
  return `<div class="flex items-center gap-1 flex-wrap">
    <span class="text-xs opacity-60 mr-1">Кыргызские буквы:</span>${buttons}
    <span class="opacity-30 mx-1">|</span>${upper}
  </div>`;
}

/** Кнопки вставляют букву, Alt+O/U/N делают то же с клавиатуры. */
function attachKyrgyzHelper(textarea, container) {
  if (container) {
    container.querySelectorAll(".ky-letter").forEach((btn) => {
      // mousedown, а не click: клик сначала уводит фокус из поля, и вставлять
      // становится некуда.
      btn.addEventListener("mousedown", (event) => {
        event.preventDefault();
        insertAtCursor(textarea, btn.dataset.letter);
      });
    });
  }

  textarea.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    const letter = KYRGYZ_LETTERS.find((l) => l.code === event.code);
    if (!letter) return;
    event.preventDefault();
    insertAtCursor(textarea, event.shiftKey ? letter.upper : letter.lower);
  });
}

// ---------------------------------------------------------------------------
// Инструкция
// ---------------------------------------------------------------------------

const HELP_SECTIONS = [
  {
    id: "start",
    title: "С чего начать",
    body: `
      <p>Задача — собрать аудио с точной расшифровкой, чтобы на нём дообучить модель распознавания.
      Чем аккуратнее расшифровка, тем лучше модель научится слышать язык.</p>
      <ol class="list-decimal ml-5 space-y-1">
        <li>На странице <b>Записи</b> добавьте видео или аудио — ссылкой или файлом.</li>
        <li>Подождите, пока запись подготовится: она сама режется на короткие фрагменты и распознаётся.</li>
        <li>Откройте её и пройдите фрагменты по порядку, исправляя ошибки распознавания.</li>
        <li>Когда все фрагменты пройдены — нажмите <b>Запись готова</b>.</li>
      </ol>`,
  },
  {
    id: "add",
    title: "Как добавить запись",
    body: `
      <p>Собираем <b>кыргызскую</b> речь — язык у всех записей один, выбирать его не нужно.</p>
      <p><b>Название</b> — необязательно, нужно только чтобы вы сами узнали запись в списке.</p>
      <p><b>Ссылка</b> — на YouTube, TikTok, Instagram или прямую ссылку на файл.
      <b>Файл</b> — аудио или видео с компьютера, до 200 МБ.</p>
      <p class="opacity-80">Подготовка занимает несколько минут. Страницу можно закрыть и вернуться позже —
      процесс идёт на сервере.</p>`,
  },
  {
    id: "states",
    title: "Что означают состояния записи",
    body: `
      <ul class="space-y-2">
        <li><span class="badge badge-ghost badge-sm">В очереди</span> — принята, вот-вот начнётся.</li>
        <li><span class="badge badge-info badge-sm">Готовится</span> — скачивается, режется и распознаётся.
        Рядом видно, что именно сейчас происходит.</li>
        <li><span class="badge badge-primary badge-sm">Можно размечать</span> — фрагменты готовы, ждут вычитки.</li>
        <li><span class="badge badge-success badge-sm">Завершена</span> — вы отметили её готовой. Её можно вернуть в работу.</li>
        <li><span class="badge badge-error badge-sm">Ошибка</span> — подготовка не удалась, причина написана рядом.
        Чаще всего это недоступная ссылка.</li>
      </ul>
      <p><b>Готово</b> в списке — сколько фрагментов уже пройдено из общего числа.</p>
      <p><b>Кто взял</b> — запись закрепляется за тем, кто её открыл. Остальные могут её смотреть, но не править:
      иначе двое переписывали бы один текст и затирали работу друг друга.</p>`,
  },
  {
    id: "editing",
    title: "Как править фрагменты",
    body: `
      <p>Каждый фрагмент — это 5–15 секунд речи и то, что услышала модель. Послушайте и исправьте текст.</p>
      <ul class="space-y-2">
        <li><b>Готово</b> — текст верен, фрагмент идёт в датасет. Курсор сам перейдёт к следующему.</li>
        <li><b>Брак</b> — фрагмент не годится: там шум, музыка, обрывок слова или несколько голосов разом.
        В датасет он не попадёт. Отмечать брак — это нормально и полезно, плохой пример вредит модели.</li>
        <li><b>Как было</b> — вернуть исходный текст модели, если правка не удалась.</li>
      </ul>
      <p><span class="badge badge-warning badge-xs">срез</span> — в этом месте не нашлось паузы,
      и фрагмент разрезан принудительно. Проверьте начало и конец: слово могло разорваться пополам.
      Если разорвалось — отметьте <b>Брак</b>.</p>
      <p><b>Текст сохраняется сам</b>, пока вы печатаете. Отдельной кнопки «сохранить» нет,
      надпись «сохранено» появляется справа сверху фрагмента.</p>`,
  },
  {
    id: "howto-write",
    title: "Как записывать текст",
    body: `
      <p>Пишите ровно то, что слышно, обычными словами и буквами:</p>
      <ul class="space-y-1">
        <li>числа — словами («Бир миң тогуз жүз токсон жети» вместо «1997»), модель учится звучанию, а не цифрам;</li>
        <li>сокращения — полностью, как они произносятся;</li>
        <li>оговорки и повторы оставляйте, если они реально произнесены;</li>
        <li>не дописывайте то, чего не слышно, и не приглаживайте речь до литературной.</li>
      </ul>
      <p>Знаки препинания не ставьте вообще</p>
      <p>Большие буквы не пишите - никогда, даже если это название места</p>`,
  },
  {
    id: "letters",
    title: "Буквы ө, ү, ң — как их набрать",
    body: `
      <p>Этих трёх букв нет в русской раскладке, а ставить кыргызскую ради них необязательно.
      В редакторе под каждым полем есть кнопки — нажмите, и буква встанет туда, где стоит курсор:</p>
      <p class="flex gap-1 flex-wrap">
        <span class="btn btn-xs btn-outline no-animation">ө</span>
        <span class="btn btn-xs btn-outline no-animation">ү</span>
        <span class="btn btn-xs btn-outline no-animation">ң</span>
        <span class="btn btn-xs btn-ghost no-animation">Ө</span>
        <span class="btn btn-xs btn-ghost no-animation">Ү</span>
        <span class="btn btn-xs btn-ghost no-animation">Ң</span>
      </p>
      <p>С клавиатуры быстрее:</p>
      <ul class="space-y-1">
        <li><kbd class="kbd kbd-sm">Alt</kbd> + <kbd class="kbd kbd-sm">O</kbd> → <b>ө</b></li>
        <li><kbd class="kbd kbd-sm">Alt</kbd> + <kbd class="kbd kbd-sm">U</kbd> → <b>ү</b></li>
        <li><kbd class="kbd kbd-sm">Alt</kbd> + <kbd class="kbd kbd-sm">N</kbd> → <b>ң</b></li>
      </ul>
      <p class="opacity-80">С <kbd class="kbd kbd-sm">Shift</kbd> получится заглавная. Сочетания смотрят на саму
      клавишу, поэтому работают и в русской раскладке, и в английской — переключаться не нужно.</p>
      <p><b>Это важнее, чем кажется.</b> «о» вместо «ө» и «у» вместо «ү» — разные звуки и разные слова
      (<i>көл</i> «озеро» и <i>кол</i> «рука»). Если писать их одинаково, модель выучит, что разницы нет,
      и перестанет их различать. Проверяйте эти буквы отдельно, даже когда остальной текст верен.</p>
      <p class="opacity-80">Буква <b>ё</b> и мягкий знак в заимствованиях пишутся как обычно, по-русски.</p>`,
  },
  {
    id: "mixed",
    title: "Если в записи не только кыргызская речь",
    body: `
      <p>Так бывает почти всегда: интервью на кыргызском, а внутри русские слова, вставки или целая реплика.
      Решение принимается <b>по каждому фрагменту отдельно</b>, а не по записи целиком.
      Запись, где 90% кыргызского и 10% русского, добавлять можно и нужно — просто часть фрагментов уйдёт в брак.</p>
      <ul class="space-y-2">
        <li><b>Кыргызская речь с русскими словами внутри</b> («компьютерди иштетип койдум», «телефон», «автобус») —
        оставляйте и пишите как слышно, русские слова по-русски. Так и говорят на самом деле,
        и модель должна это уметь. Это хороший материал, не брак.</li>
        <li><b>Фрагмент целиком на русском</b> — <b>Брак</b>. Кыргызской речи там нет, учить на нём нечему.</li>
        <li><b>Внутри фрагмента язык переключается посередине</b>, и обе части длинные —
        <b>Брак</b>. Разрезать фрагмент вручную нельзя, а половина на чужом языке портит пример.</li>
        <li><b>Говорят двое разом на разных языках</b> или русский голос перекрывает кыргызский — <b>Брак</b>.</li>
      </ul>
      <p class="opacity-80">Короткое правило: если фрагмент звучит как <i>кыргызская фраза</i> — берём,
      даже с заимствованиями. Если как <i>русская фраза</i> или как половина одного и половина другого — брак.</p>`,
  },
  {
    id: "keys",
    title: "Горячие клавиши",
    body: `
      <ul class="space-y-1">
        <li><kbd class="kbd kbd-sm">Ctrl</kbd> + <kbd class="kbd kbd-sm">Enter</kbd> — подтвердить фрагмент и перейти к следующему</li>
        <li><kbd class="kbd kbd-sm">Ctrl</kbd> + <kbd class="kbd kbd-sm">Space</kbd> — переслушать фрагмент с начала</li>
      </ul>
      <p class="opacity-80">Обе работают, когда курсор стоит в поле текста.</p>`,
  },
  {
    id: "roles",
    title: "Роли и права",
    body: `
      <p>У каждого своя учётная запись и одна из трёх ролей. Роль видна рядом с вашим именем вверху справа.</p>
      <ul class="space-y-2">
        <li><b>Смотритель</b> — видит записи и статистику, слушает фрагменты, читает расшифровки.
        Ничего не меняет и не выгружает. Роль для тех, кто следит за ходом работы.</li>
        <li><b>Разметчик</b> — всё то же плюс главное: добавляет записи, берёт их в работу
        и правит расшифровки. Не удаляет записи и не выгружает корпус.</li>
        <li><b>Супер-админ</b> — всё вышеперечисленное, а сверх того: заводит и удаляет
        пользователей, меняет им роли и пароли, удаляет записи, собирает и скачивает выгрузку.</li>
      </ul>
      <p><b>Свой пароль</b> может сменить кто угодно: нажмите на своё имя вверху справа →
      «Сменить свой пароль». Понадобится текущий пароль.</p>
      <p class="opacity-80">Если пароль забыт — его поставит заново супер-админ: напишите ему  <a class="link link-primary" href="https://t.me/${TELEGRAM_CONTACT}" target="_blank" rel="noopener">@${TELEGRAM_CONTACT}</a>.</p>`,
  },
  {
    id: "export",
    title: "Выгрузка датасета",
    body: `
      <p>Доступна администратору. В архив попадают только фрагменты, отмеченные <b>Готово</b>.</p>
      <p>Внутри — папка <code>clips/</code> с аудио и два описания одного и того же:
      <code>manifest.jsonl</code> для NeMo (на нём обучается модель) и <code>metadata.csv</code> для HuggingFace.
      Оба формата собираются сразу, чтобы не переделывать под конкретный инструмент.</p>`,
  },
];

function mountHelpDialog() {
  if ($("helpDialog")) return;

  const dialog = document.createElement("dialog");
  dialog.id = "helpDialog";
  dialog.className = "modal";
  dialog.innerHTML = `
    <div class="modal-box max-w-3xl">
      <form method="dialog">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-3 top-3">✕</button>
      </form>
      <h3 class="font-bold text-xl mb-1">Инструкция</h3>
      <p class="text-sm opacity-70 mb-4">Как размечать аудио и что означает каждая кнопка.</p>

      <!-- Переходы по разделам только на широком экране: на телефоне их роль
           играет сам список свёрнутых заголовков. -->
      <div class="hidden sm:flex flex-wrap gap-1 mb-4">
        ${HELP_SECTIONS.map((s) => `<button class="btn btn-xs btn-ghost" data-jump="${s.id}">${s.title}</button>`).join("")}
      </div>

      <!-- Без своей прокрутки: внутренняя область скролла внутри окна, которое
           тоже скроллится, даёт две полосы сразу, и палец попадает не в ту. -->
      <div class="space-y-2 text-sm" id="helpBody">
        ${HELP_SECTIONS.map((s) => `
          <details id="help-${s.id}" class="help-section border-b border-base-300 pb-2">
            <summary class="font-semibold text-base cursor-pointer py-2 list-none flex items-center justify-between gap-2">
              <span>${s.title}</span>
              <span class="opacity-40 text-sm shrink-0">▾</span>
            </summary>
            <div class="space-y-2 opacity-90 pt-1 pb-2">${s.body}</div>
          </details>`).join("")}

        <section class="pt-3">
          <h4 class="font-semibold text-base mb-2">Остались вопросы</h4>
          <p class="opacity-90">
            Если что-то непонятно, не работает или ведёт себя странно — напишите
            <a class="link link-primary" href="https://t.me/${TELEGRAM_CONTACT}" target="_blank" rel="noopener">@${TELEGRAM_CONTACT}</a>
            в Telegram.
          </p>
        </section>
      </div>

      <div class="modal-action">
        <form method="dialog"><button class="btn">Понятно</button></form>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop"><button>закрыть</button></form>`;

  document.body.append(dialog);

  dialog.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.onclick = (event) => {
      event.preventDefault();
      const target = $("help-" + btn.dataset.jump);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
}

/** Широкий экран показывает всё сразу, телефон — список заголовков. */
function isWideScreen() {
  return window.matchMedia("(min-width: 640px)").matches;
}

function openHelp(sectionId) {
  mountHelpDialog();
  const dialog = $("helpDialog");
  const sections = [...dialog.querySelectorAll(".help-section")];

  // Разворачиваем заново при каждом открытии: экран мог повернуться, да и
  // оставлять телефону десять развёрнутых разделов — это ровно то листание,
  // от которого мы уходим.
  const wide = isWideScreen();
  sections.forEach((section) => {
    section.open = wide;
  });

  dialog.showModal();
  dialog.querySelector(".modal-box").scrollTop = 0;

  if (sectionId) {
    const target = $("help-" + sectionId);
    if (target) {
      target.open = true;
      target.scrollIntoView({ block: "start" });
    }
  }
}
