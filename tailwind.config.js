/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        claude: {
          DEFAULT: '#D97757',
          50:  '#FBF1EC',
          100: '#F5DCCF',
          200: '#EEBFAA',
          300: '#E69F7F',
          400: '#DF8663',
          500: '#D97757',
          600: '#B75E40',
          700: '#8E4830',
          800: '#653321',
          900: '#3D1F14',
        },
        ink: {
          50:  '#F7F6F2',
          100: '#EDEBE4',
          200: '#D7D3C7',
          300: '#B5AFA0',
          400: '#8A8474',
          500: '#5F5A4D',
          600: '#3F3B32',
          700: '#2B2823',
          800: '#1F1E1D',
          900: '#14130F',
        },
        paper: {
          DEFAULT: '#FAF9F5',
          muted: '#F3F1EB',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Pretendard', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(31,30,29,0.04), 0 4px 16px rgba(31,30,29,0.06)',
      },
      keyframes: {
        pulseClaude: {
          '0%, 100%': { transform: 'rotate(0deg) scale(1)', opacity: '1' },
          '50%':      { transform: 'rotate(45deg) scale(1.06)', opacity: '0.92' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'claude-pulse': 'pulseClaude 4s ease-in-out infinite',
        shimmer: 'shimmer 2s linear infinite',
      },
    },
  },
  plugins: [],
}
