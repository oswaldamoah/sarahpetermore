/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 'navy' = brand ink (deep berry plum). Name kept so every screen picks it up.
        navy: { DEFAULT: '#2D1233', 50: '#F8F0F8', 100: '#F0E0F0', 200: '#DCC0DD', 600: '#240E29', 700: '#1B0A1F', 900: '#0F0512' },
        sage: { DEFAULT: '#C9B8FF', 50: '#F6F2FF', 100: '#ECE5FF', 700: '#147A4C', 800: '#0E5E39' },
        cream: { DEFAULT: '#FFF6FA', 100: '#FFEAF3', 200: '#FFD9EA' },
        // 'ember' = bubblegum pink, the brand accent (buttons, highlights).
        ember: { DEFAULT: '#FF7AB8', 50: '#FFF0F7', 600: '#F2559F', 700: '#B8236A' },
        charcoal: { DEFAULT: '#43354A', 300: '#BBA9C0', 400: '#8B7891', 500: '#66566D', 800: '#2D2233' },
        kraft: { DEFAULT: '#D8C3A0', 100: '#EFE3CC', 200: '#E4D2B3', 600: '#A98A5C', 700: '#8A6E45' },
      },
      fontFamily: {
        // One family everywhere (Inter). 'serif' is kept as a name for headings/wordmark so existing classes still work.
        serif: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        // modular scale ~1.25
        'xs': ['0.8rem', '1.15rem'], 'sm': ['0.9rem', '1.35rem'], 'base': ['1rem', '1.6rem'], 'lg': ['1.2rem', '1.75rem'],
        'xl': ['1.5rem', '2rem'], '2xl': ['1.9rem', '2.3rem'], '3xl': ['2.4rem', '2.7rem'], '4xl': ['3.1rem', '3.3rem'], '5xl': ['4rem', '4rem'],
      },
      boxShadow: { parcel: '0 1px 0 #A98A5C, 0 12px 30px -12px rgba(66,50,20,.35)', card: '0 1px 2px rgba(45,18,51,.06), 0 10px 30px -14px rgba(45,18,51,.28)', pop: '0 4px 0 0 #E0448F', 'pop-ink': '0 4px 0 0 #000' },
      borderRadius: { blob: '28px' },
    },
  },
  plugins: [],
};
