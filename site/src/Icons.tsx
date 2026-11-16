import type { ReactNode, SVGProps } from 'react'

function Base({ children, ...p }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...p}
    >
      {children}
    </svg>
  )
}

export const IconCopy = () => (
  <Base>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" />
  </Base>
)
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M5 12.5 10 17.5 19 7" />
  </Base>
)
export const IconDownload = () => (
  <Base>
    <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />
  </Base>
)
export const IconGithub = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49l-.01-1.7c-2.78.62-3.37-1.21-3.37-1.21-.46-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.56 2.35 1.11 2.92.85.09-.66.35-1.11.64-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.4 9.4 0 0 1 12 6.98c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.24 10.24 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z" />
  </svg>
)
export const IconNpm = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
  </svg>
)
export const IconSun = () => (
  <Base>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
  </Base>
)
export const IconMoon = () => (
  <Base>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Base>
)
export const IconReplay = () => (
  <Base>
    <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" />
  </Base>
)
export const IconPause = () => (
  <Base>
    <path d="M9 5v14M15 5v14" />
  </Base>
)
export const IconPlay = () => (
  <Base>
    <path d="M7 5v14l12-7z" />
  </Base>
)
export const IconLossless = () => (
  <Base>
    <path d="M4 7h10M4 12h16M4 17h7" />
    <path d="m15 15 2 2 4-4" />
  </Base>
)
export const IconShield = () => (
  <Base>
    <path d="M12 3 5 6v5.5c0 4.2 3 7.8 7 9.5 4-1.7 7-5.3 7-9.5V6z" />
    <path d="M9.5 12.5 11.5 14.5 15 10.5" />
  </Base>
)
export const IconExpand = () => (
  <Base>
    <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
  </Base>
)
export const IconEye = () => (
  <Base>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.8" />
  </Base>
)
export const IconLock = () => (
  <Base>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Base>
)
export const IconPlug = () => (
  <Base>
    <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" />
  </Base>
)
export const IconInfo = () => (
  <Base>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.5v.01" />
  </Base>
)
export const IconArrow = () => (
  <Base>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Base>
)

export const IconChart = () => (
  <Base>
    <path d="M4 20h16M7 16V10M12 16V5M17 16v-3" />
  </Base>
)
export const IconStar = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M12 2.8l2.83 5.73 6.33.92-4.58 4.46 1.08 6.3L12 17.24l-5.66 2.97 1.08-6.3-4.58-4.46 6.33-.92z" />
  </svg>
)
/**
 * The tiny-browse logo: a black tile in both themes (a Markdown page: a green heading hash, a
 * heading and text lines, with a magnifier finding the green lines). The tile's shadow is in CSS
 * (.brand__mark) so it can differ per theme. Same drawing as public/favicon.svg.
 */
export function Mark({ className = 'brand__mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="112" fill="#0c0c0b" />
      <rect x="4" y="4" width="504" height="504" rx="108" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="8" />
      <g stroke="#7fd4a0" strokeWidth="22" strokeLinecap="round">
        <path d="M128 100 116 196M168 100 156 196M98 128h96M92 168h96" />
      </g>
      <rect x="222" y="124" width="196" height="36" rx="18" fill="#edece8" />
      <rect x="96" y="232" width="320" height="26" rx="13" fill="#5f5e58" />
      <rect x="96" y="292" width="200" height="26" rx="13" fill="#5f5e58" />
      <rect x="96" y="352" width="128" height="26" rx="13" fill="#5f5e58" />
      <circle cx="340" cy="342" r="64" fill="#0c0c0b" stroke="#edece8" strokeWidth="22" />
      <rect x="304" y="318" width="72" height="20" rx="10" fill="#7fd4a0" />
      <rect x="304" y="348" width="46" height="20" rx="10" fill="#7fd4a0" fillOpacity="0.55" />
      <path d="M388 390l44 44" stroke="#edece8" strokeWidth="30" strokeLinecap="round" />
    </svg>
  )
}
export const IconSearch = () => (
  <Base>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.5-4.5" />
  </Base>
)
export const IconTerminal = () => (
  <Base>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5" />
  </Base>
)
export const IconPlus = () => (
  <Base>
    <path d="M12 5v14M5 12h14" />
  </Base>
)
export const IconBug = () => (
  <Base>
    <rect x="7" y="7" width="10" height="13" rx="5" />
    <path d="M12 11v9M7 12H3M21 12h-4M7 17H4M20 17h-3M8.5 7 7 4.5M15.5 7 17 4.5M9 7.5a3 3 0 0 1 6 0" />
  </Base>
)
export const IconSpark = () => (
  <Base>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </Base>
)
export const IconCode = () => (
  <Base>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4 10.5 20" />
  </Base>
)
export const IconChat = () => (
  <Base>
    <path d="M4 5.5h16v10H9l-5 4z" />
  </Base>
)
export const IconBook = () => (
  <Base>
    <path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2zM4 20a2 2 0 0 0 2 2h13v-4" />
  </Base>
)
export const IconLinkedin = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.95v5.66H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z" />
  </svg>
)
