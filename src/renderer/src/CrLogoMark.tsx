/** Cookrew logo mark: baby hand flashing a two-finger "yes", contour traced
    from the original photo — index raking up-left, tall middle finger, curled
    ring + tucked thumb on the right, chubby forearm exiting the frame.
    Same language as the wordmark: ink outline, cream body, hard amber shadow. */
const HAND_PATH =
  'M 16.6 1.4 C 17.5 1.4 18.1 1.9 18.2 2.8 C 18.6 5.4 18.9 8.4 19.2 10.6 ' +
  'C 19.3 11.0 19.5 11.0 19.7 10.7 C 20.0 10.2 20.5 9.6 21.0 9.7 C 21.6 9.8 21.9 10.4 22.1 10.8 ' +
  'C 22.8 10.2 23.9 9.8 24.8 10.3 C 26.1 11.1 27.1 12.5 27.2 13.8 C 27.3 14.8 27.1 15.7 26.9 16.5 ' +
  'C 26.6 17.4 26.2 18.0 25.8 18.6 C 25.3 19.4 24.5 21.4 24.1 23.2 C 23.7 25.6 23.1 29.5 22.7 33 ' +
  'L 8.9 33 C 9.1 30.6 9.6 27.8 10.4 26.3 C 10.7 25.6 10.9 24.8 11.0 24.0 C 10.6 23.0 10.1 22.0 9.8 21.0 ' +
  'C 9.4 19.8 9.0 18.5 8.7 17.4 C 8.3 16.0 7.4 14.5 6.9 13.4 C 6.1 11.8 5.1 9.4 4.5 7.7 ' +
  'C 4.1 6.6 4.3 5.7 5.1 5.2 C 5.9 4.7 6.8 4.9 7.1 5.8 C 8.0 7.6 10.9 10.2 13.0 11.3 ' +
  'C 13.4 11.6 13.5 12.0 13.7 12.0 C 13.9 12.0 14.2 11.7 14.4 11.2 C 14.9 9.9 15.0 5.3 15.1 3.0 ' +
  'C 15.2 1.9 15.7 1.4 16.6 1.4 Z'

const WRIST_CREASE = 'M 13.2 23.9 Q 17.6 23.2 22.8 23.7'

export function CrLogoMark(): React.JSX.Element {
  return (
    <svg
      className="cr-logo-mark"
      viewBox="0 0 32 32"
      role="img"
      aria-label="Cookrew logo: baby hand saying yes"
    >
      <defs>
        <path id="cr-logo-hand" d={HAND_PATH} />
      </defs>
      <use
        href="#cr-logo-hand"
        transform="translate(2 2)"
        fill="var(--amber)"
        stroke="var(--amber)"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <use
        href="#cr-logo-hand"
        fill="var(--ink)"
        stroke="var(--ink)"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <use href="#cr-logo-hand" fill="var(--cream-hi)" />
      <path
        d={WRIST_CREASE}
        fill="none"
        stroke="var(--ink)"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}
