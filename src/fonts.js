// Fonts bundled with the editor (SIL Open Font Licence, from Fontsource).
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/montserrat/400.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/montserrat/900.css';
import '@fontsource/montserrat/800-italic.css';
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import '@fontsource/poppins/800.css';
import '@fontsource/bebas-neue/400.css';
import '@fontsource/playfair-display/400.css';
import '@fontsource/playfair-display/700.css';
import '@fontsource/playfair-display/700-italic.css';
import '@fontsource/oswald/400.css';
import '@fontsource/oswald/600.css';
import '@fontsource/dm-serif-display/400.css';
import '@fontsource/dm-serif-display/400-italic.css';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/roboto-mono/500.css';

export const BUNDLED_FACES = [
  '400 40px "Inter"',
  '700 40px "Inter"',
  '800 40px "Montserrat"',
  '900 40px "Montserrat"',
  '700 40px "Poppins"',
  '400 40px "Bebas Neue"',
  '700 40px "Playfair Display"',
  '600 40px "Oswald"',
  '400 40px "DM Serif Display"',
  '500 40px "Roboto Mono"',
];

export function preloadFonts() {
  return Promise.all(BUNDLED_FACES.map((f) => document.fonts.load(f).catch(() => null)));
}
