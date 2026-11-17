"use strict";
// "Tell us what you think": a star rating and a message that show up on the admin Client page.
(function () {
  const footer = document.querySelector(".footer");
  if (!footer) return;
  const token = () => localStorage.getItem("ss_auth_token") || "";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn comment-open";
  open.textContent = "💬 Leave a comment";
  footer.appendChild(open);

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal comment-modal" role="dialog" aria-modal="true" aria-labelledby="cmTitle">
      <button class="close" type="button" aria-label="Close" data-cm-close>×</button>
      <h2 id="cmTitle">Tell us what you think</h2>
      <form id="cmForm" novalidate>
        <fieldset class="cm-stars">
          <legend>How was it?</legend>
          <div class="cm-row" role="radiogroup" aria-label="Rating">
            ${[5, 4, 3, 2, 1].map((n) => `<label class="cm-star" title="${n} star${n > 1 ? "s" : ""}"><input type="radio" name="rating" value="${n}"><span aria-hidden="true">★</span><span class="sr">${n} star${n > 1 ? "s" : ""}</span></label>`).join("")}
          </div>
        </fieldset>
        <label>Your comment
          <textarea name="message" rows="4" maxlength="600" placeholder="What did you like? What can we do better?" required></textarea>
        </label>
        <p class="error" id="cmError" role="alert" hidden></p>
        <button class="btn primary block" type="submit" id="cmSend">Send comment</button>
      </form>
      <p class="cm-done" id="cmDone" hidden>Thank you! The shop owner will read your comment.</p>
    </div>`;
  document.body.appendChild(overlay);

  const $ = (s) => overlay.querySelector(s);
  const form = $("#cmForm");
  function show(v) {
    overlay.hidden = !v;
    document.body.style.overflow = v ? "hidden" : "";
    if (v) {
      $("#cmDone").hidden = true; form.hidden = false; $("#cmError").hidden = true;
      (form.elements.message).focus();
    }
  }
  open.addEventListener("click", () => {
    if (!token()) { location.href = "/profile.html"; return; }
    show(true);
  });
  overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target.closest("[data-cm-close]")) show(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) show(false); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#cmError");
    err.hidden = true;
    const message = form.elements.message.value.trim();
    const rating = (form.querySelector("input[name=rating]:checked") || {}).value;
    if (message.length < 3) { err.textContent = "Please write your comment (at least 3 characters)."; err.hidden = false; return; }
    const btn = $("#cmSend");
    btn.disabled = true;
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
        body: JSON.stringify({ message, rating: rating ? Number(rating) : null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not send your comment.");
      form.reset(); form.hidden = true; $("#cmDone").hidden = false;
      setTimeout(() => show(false), 2200);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    finally { btn.disabled = false; }
  });
})();
