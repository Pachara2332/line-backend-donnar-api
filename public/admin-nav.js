'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('.staff-nav');
  const active = nav && nav.querySelector('.active');
  if (!active || nav.scrollWidth <= nav.clientWidth) return;
  const navBox = nav.getBoundingClientRect();
  const activeBox = active.getBoundingClientRect();
  nav.scrollLeft += activeBox.left - navBox.left - (navBox.width - activeBox.width) / 2;
});
