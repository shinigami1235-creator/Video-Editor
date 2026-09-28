// Text and caption style presets.

import { defaultTextStyle } from '../core/model.js';

const T = (o) => ({ ...defaultTextStyle(), ...o });

export const TEXT_PRESETS = [
  {
    name: 'Title',
    sample: 'Title',
    text: 'Big title',
    style: T({ font: 'Montserrat', size: 120, weight: 900, uppercase: true, shadowBlur: 20 }),
    anim: { in: { type: 'pop', duration: 0.5 }, out: { type: 'fade', duration: 0.4 }, loop: null },
  },
  {
    name: 'Elegant title',
    sample: 'Elegant',
    text: 'Elegant title',
    style: T({ font: 'Playfair Display', size: 110, weight: 700, letterSpacing: 2, shadowBlur: 16 }),
    anim: { in: { type: 'blurIn', duration: 0.8 }, out: { type: 'fade', duration: 0.5 }, loop: null },
  },
  {
    name: 'Subtitle',
    sample: 'Subtitle',
    text: 'A short line under the title',
    style: T({ font: 'Inter', size: 56, weight: 500, shadowBlur: 10 }),
    props: { yFrac: 0.12 },
    anim: { in: { type: 'slideUp', duration: 0.5 }, out: { type: 'fade', duration: 0.4 }, loop: null },
  },
  {
    name: 'Lower third',
    sample: 'Name / Role',
    duration: 5,
    parts: [
      { name: 'Name', text: 'Dr. Your Name', style: T({ font: 'Montserrat', size: 64, weight: 800, align: 'left', boxEnabled: true, boxColor: 'rgba(15,17,22,0.85)', boxPadding: 22, boxRadius: 8, shadowBlur: 0, maxWidth: 0.7 }), props: { yFrac: 0.3, xFrac: -0.14 }, anim: { in: { type: 'slideRight', duration: 0.5 }, out: { type: 'slideLeft', duration: 0.4 }, loop: null } },
      { name: 'Role', text: 'Aesthetic physician', style: T({ font: 'Inter', size: 40, weight: 500, align: 'left', color: '#e8c16a', boxEnabled: true, boxColor: 'rgba(15,17,22,0.85)', boxPadding: 16, boxRadius: 8, shadowBlur: 0, maxWidth: 0.7 }), props: { yFrac: 0.36, xFrac: -0.14 }, anim: { in: { type: 'slideRight', duration: 0.6 }, out: { type: 'slideLeft', duration: 0.4 }, loop: null } },
    ],
  },
  {
    name: 'Call to action',
    sample: 'Book now',
    text: 'Book your consultation',
    style: T({ font: 'Poppins', size: 64, weight: 700, color: '#15171c', boxEnabled: true, boxColor: 'rgba(232,193,106,1)', boxPadding: 28, boxRadius: 40, shadowBlur: 0 }),
    props: { yFrac: 0.3 },
    anim: { in: { type: 'pop', duration: 0.45 }, out: { type: 'fade', duration: 0.3 }, loop: { type: 'pulse', period: 1.6, amount: 1 } },
  },
  {
    name: 'Price tag',
    sample: 'P 1,499',
    text: 'P 1,499',
    style: T({ font: 'Bebas Neue', size: 150, weight: 400, color: '#ffffff', outlineWidth: 0, shadowBlur: 24, letterSpacing: 2 }),
    anim: { in: { type: 'zoomOut', duration: 0.5 }, out: { type: 'fade', duration: 0.3 }, loop: null },
  },
  {
    name: 'Step label',
    sample: 'Step 1',
    text: 'Step 1: Cleanse',
    style: T({ font: 'Montserrat', size: 58, weight: 700, boxEnabled: true, boxColor: 'rgba(255,255,255,0.92)', color: '#15171c', boxPadding: 20, boxRadius: 12, shadowBlur: 0 }),
    props: { yFrac: -0.36 },
    anim: { in: { type: 'slideDown', duration: 0.4 }, out: { type: 'fade', duration: 0.3 }, loop: null },
  },
  {
    name: 'Chapter',
    sample: '01  Intro',
    text: '01  Introduction',
    style: T({ font: 'Oswald', size: 90, weight: 600, uppercase: true, letterSpacing: 6, shadowBlur: 18 }),
    anim: { in: { type: 'wipe', duration: 0.6 }, out: { type: 'fade', duration: 0.4 }, loop: null },
  },
  {
    name: 'Typewriter',
    sample: 'Typing',
    text: 'Results you can see',
    style: T({ font: 'Roboto Mono', size: 64, weight: 500, shadowBlur: 8 }),
    reveal: 'typewriter',
  },
  {
    name: 'Quote',
    sample: '"Quote"',
    text: '"The best skin is healthy skin."',
    style: T({ font: 'DM Serif Display', size: 76, weight: 400, italic: true, shadowBlur: 14 }),
    anim: { in: { type: 'fade', duration: 0.8 }, out: { type: 'fade', duration: 0.6 }, loop: null },
  },
];

export const CAPTION_PRESETS = [
  {
    id: 'bold-highlight',
    name: 'Bold highlight',
    style: { font: 'Montserrat', size: 72, weight: 900, color: '#ffffff', uppercase: true, outlineWidth: 7, outlineColor: '#000000', shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.6)', boxEnabled: false, highlightColor: '#f5c542', highlightMode: 'color' },
    reveal: 'karaoke',
  },
  {
    id: 'clean',
    name: 'Clean white',
    style: { font: 'Inter', size: 60, weight: 700, color: '#ffffff', uppercase: false, outlineWidth: 0, outlineColor: '#000000', shadowBlur: 14, shadowColor: 'rgba(0,0,0,0.75)', boxEnabled: false, highlightColor: '#ffffff', highlightMode: 'color' },
    reveal: 'none',
  },
  {
    id: 'boxed',
    name: 'Boxed',
    style: { font: 'Poppins', size: 58, weight: 600, color: '#ffffff', uppercase: false, outlineWidth: 0, outlineColor: '#000000', shadowBlur: 0, shadowColor: 'rgba(0,0,0,0)', boxEnabled: true, boxColor: 'rgba(0,0,0,0.7)', highlightColor: '#f5c542', highlightMode: 'color' },
    reveal: 'karaoke',
  },
  {
    id: 'pill',
    name: 'Word pill',
    style: { font: 'Montserrat', size: 68, weight: 800, color: '#ffffff', uppercase: false, outlineWidth: 5, outlineColor: '#000000', shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.5)', boxEnabled: false, highlightColor: '#7c5cff', highlightMode: 'box' },
    reveal: 'karaoke',
  },
  {
    id: 'pop',
    name: 'Pop words',
    style: { font: 'Poppins', size: 76, weight: 800, color: '#ffffff', uppercase: true, outlineWidth: 6, outlineColor: '#111111', shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.5)', boxEnabled: false, highlightColor: '#4ee18a', highlightMode: 'scale' },
    reveal: 'karaoke',
  },
  {
    id: 'lecture',
    name: 'Lecture subtitle',
    style: { font: 'Inter', size: 44, weight: 500, color: '#ffffff', uppercase: false, outlineWidth: 0, outlineColor: '#000000', shadowBlur: 0, shadowColor: 'rgba(0,0,0,0)', boxEnabled: true, boxColor: 'rgba(0,0,0,0.6)', highlightColor: '#ffffff', highlightMode: 'color' },
    reveal: 'none',
    y: 0.88,
    maxWords: 12,
  },
  {
    id: 'gold',
    name: 'Gold serif',
    style: { font: 'Playfair Display', size: 64, weight: 700, color: '#ffffff', uppercase: false, outlineWidth: 0, outlineColor: '#000000', shadowBlur: 12, shadowColor: 'rgba(0,0,0,0.7)', boxEnabled: false, highlightColor: '#e8c16a', highlightMode: 'color' },
    reveal: 'karaoke',
  },
];
