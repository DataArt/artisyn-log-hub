// Mobile menu toggle for the Log Hub site (impl-plan DD-17). Below 768 px the top nav and the
// docs sidebar are hidden until the "Menu" button opens them (body.menu-open, see theme.css).
(function () {
  'use strict';

  function init() {
    var button = document.querySelector('.menu-toggle');
    if (!button) return;
    button.addEventListener('click', function () {
      var open = document.body.classList.toggle('menu-open');
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
