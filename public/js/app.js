/* refer.GemzOnline — small interface helpers. No framework, no build step. */
(function () {
  'use strict';

  // --- copy to clipboard ---------------------------------------------------
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();

    var value = btn.getAttribute('data-copy');
    if (!value) {
      var target = document.querySelector(btn.getAttribute('data-copy-target'));
      if (target) value = target.value || target.textContent;
    }
    if (!value) return;

    var done = function () {
      var original = btn.getAttribute('data-original') || btn.textContent;
      btn.setAttribute('data-original', original);
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = original; }, 1600);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done).catch(fallback);
    } else {
      fallback();
    }

    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* nothing to do */ }
      document.body.removeChild(ta);
    }
  });

  // --- confirm destructive actions ----------------------------------------
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      e.preventDefault();
      return;
    }
    // Stop double submits on slow connections.
    var submit = form.querySelector('button[type=submit]:not([data-no-lock])');
    if (submit && !form.hasAttribute('data-no-lock')) {
      setTimeout(function () {
        submit.disabled = true;
        if (!submit.dataset.busyLabel) submit.dataset.busyLabel = submit.textContent;
        submit.textContent = submit.getAttribute('data-busy') || 'Working…';
      }, 0);
    }
  });

  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[data-confirm]');
    if (link && !window.confirm(link.getAttribute('data-confirm'))) e.preventDefault();
  });

  // --- auto-submit filter controls ----------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll('[data-autosubmit]'), function (el) {
    el.addEventListener('change', function () {
      if (el.form) el.form.submit();
    });
  });

  // --- detect the visitor's timezone on public forms ----------------------
  Array.prototype.forEach.call(document.querySelectorAll('[data-detect-timezone]'), function (select) {
    if (select.value) return;
    try {
      var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!zone) return;
      var match = Array.prototype.find.call(select.options, function (o) { return o.value === zone; });
      if (match) {
        select.value = zone;
      } else {
        var opt = document.createElement('option');
        opt.value = zone;
        opt.textContent = zone + ' (detected)';
        select.insertBefore(opt, select.firstChild);
        select.value = zone;
      }
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) { /* leave the default */ }
  });

  // --- live timezone echo on appointment pickers --------------------------
  function renderZoneEcho() {
    var echo = document.querySelector('[data-zone-echo]');
    if (!echo) return;
    var zoneSelect = document.querySelector('[name=timezone]');
    var zone = zoneSelect ? zoneSelect.value : null;
    var dateEl = document.querySelector('[name=primary_date]');
    var timeEl = document.querySelector('[name=primary_time]');
    if (!zone || !dateEl || !timeEl || !dateEl.value || !timeEl.value) {
      echo.textContent = '';
      return;
    }
    try {
      var local = new Date(dateEl.value + 'T' + timeEl.value);
      var jam = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Jamaica', dateStyle: 'medium', timeStyle: 'short'
      }).format(local);
      echo.textContent = 'That is ' + jam + ' Jamaica time, which is when our team will call.';
    } catch (err) {
      echo.textContent = '';
    }
  }

  ['[name=timezone]', '[name=primary_date]', '[name=primary_time]'].forEach(function (sel) {
    var el = document.querySelector(sel);
    if (el) el.addEventListener('change', renderZoneEcho);
  });
  renderZoneEcho();

  // --- character counters --------------------------------------------------
  Array.prototype.forEach.call(document.querySelectorAll('[data-counter]'), function (el) {
    var out = document.querySelector(el.getAttribute('data-counter'));
    if (!out) return;
    var update = function () { out.textContent = el.value.length + ' characters'; };
    el.addEventListener('input', update);
    update();
  });
})();
