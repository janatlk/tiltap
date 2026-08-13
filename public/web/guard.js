/**
 * Защита закрытых страниц одной системой учётных записей.
 *
 * До этого страницы охранялись по-разному: разметка своими логинами, админка
 * паролем сайта. Две системы означают два места, где человека заводят, и два,
 * где его отключают. Отзыв доступа в одной оставлял вторую открытой.
 *
 * Здесь только перенаправление, то есть удобство. Настоящая защита стоит на
 * сервере: /api/admin закрыт requireAdmin, /api/dataset проверяет сессию сам.
 * Страница без данных не опасна, опасны данные без проверки.
 */
(function () {
  const HOME_BY_ROLE = {
    super_admin: "/web/admin.html",
    annotator: "/web/dataset-tasks.html",
    viewer: "/web/dataset-tasks.html",
  };

  function loginUrl() {
    return "/web/dataset.html?next=" + encodeURIComponent(location.pathname + location.search);
  }

  window.TilTapGuard = {
    homeFor(role) {
      return HOME_BY_ROLE[role] || "/web/dataset-tasks.html";
    },

    /**
     * Пускает дальше только супер-админа. Остальных уводит туда, где им есть
     * что делать, а не показывает пустую страницу с отказом.
     */
    async requireSuperAdmin() {
      let data;
      try {
        const res = await fetch("/api/dataset/session", { credentials: "same-origin" });
        data = await res.json();
      } catch (e) {
        // Сеть отвалилась. Уводить человека на вход неправильно: он никуда не
        // денется, а причина не в правах.
        return null;
      }

      if (!data.authenticated) {
        location.replace(loginUrl());
        return null;
      }
      if (data.annotator.role !== "super_admin") {
        location.replace(HOME_BY_ROLE[data.annotator.role] || "/web/dataset-tasks.html");
        return null;
      }
      return data.annotator;
    },
  };
})();
