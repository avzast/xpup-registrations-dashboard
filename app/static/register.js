(function () {
  "use strict";
  var form = document.getElementById("reg-form");
  var err = document.getElementById("r-err");
  var params = new URLSearchParams(location.search);
  // Источник берётся из ссылки: /register?source=telegram (или utm_source). Без него считаем «Сайт».
  var source = (params.get("source") || params.get("utm_source") || "Сайт").slice(0, 60);

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    err.textContent = "";
    var btn = document.getElementById("r-submit");
    btn.disabled = true;
    var body = {
      name: document.getElementById("r-name").value,
      email: document.getElementById("r-email").value,
      city: document.getElementById("r-city").value,
      age: document.getElementById("r-age").value,
      track: document.getElementById("r-track").value,
      website: document.getElementById("r-website").value,
      source: source
    };
    fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "Не удалось отправить заявку.");
        form.hidden = true;
        document.getElementById("r-ok").hidden = false;
      });
    }).catch(function (e) {
      err.textContent = e.message;
      btn.disabled = false;
    });
  });
})();
