const TASK_TIME_BEAN_SELECTOR = ".task-time-row .uptime-kuma-heartbeat";
const DRAG_THRESHOLD = 5;

type PointerGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  anchorButton: HTMLButtonElement;
  anchorWasSelected: boolean;
  lastButton: HTMLButtonElement | null;
  dragged: boolean;
};

let gesture: PointerGesture | null = null;
let allowedProgrammaticClick: HTMLButtonElement | null = null;
let blockNativeClickUntil = 0;

function closestTimeButton(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest<HTMLButtonElement>(TASK_TIME_BEAN_SELECTOR);
  if (!button || !(button instanceof HTMLButtonElement) || button.disabled) return null;
  return button;
}

function buttonFromPoint(clientX: number, clientY: number): HTMLButtonElement | null {
  return closestTimeButton(document.elementFromPoint(clientX, clientY));
}

function dispatchSelectionClick(button: HTMLButtonElement) {
  allowedProgrammaticClick = button;
  button.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    view: window,
  }));
  allowedProgrammaticClick = null;
}

function seedDragSelection(currentGesture: PointerGesture) {
  if (currentGesture.dragged) return;
  currentGesture.dragged = true;
  dispatchSelectionClick(currentGesture.anchorButton);
  if (currentGesture.anchorWasSelected) dispatchSelectionClick(currentGesture.anchorButton);
  currentGesture.lastButton = currentGesture.anchorButton;
}

function blockEvent(event: Event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function installTaskTimePickerFix() {
  document.addEventListener("pointerdown", (event) => {
    const button = closestTimeButton(event.target);
    if (!button || event.button !== 0) return;

    blockEvent(event);
    blockNativeClickUntil = Date.now() + 600;
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      anchorButton: button,
      anchorWasSelected: button.getAttribute("aria-pressed") === "true",
      lastButton: null,
      dragged: false,
    };
  }, true);

  document.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    blockEvent(event);
    blockNativeClickUntil = Date.now() + 600;
    const moved = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= DRAG_THRESHOLD;
    const button = buttonFromPoint(event.clientX, event.clientY);
    if (!moved && button === gesture.anchorButton) return;

    seedDragSelection(gesture);
    if (button && button !== gesture.lastButton) {
      dispatchSelectionClick(button);
      gesture.lastButton = button;
    }
  }, true);

  document.addEventListener("pointerup", (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;

    blockEvent(event);
    blockNativeClickUntil = Date.now() + 600;
    if (!gesture.dragged) dispatchSelectionClick(gesture.anchorButton);
    gesture = null;
  }, true);

  document.addEventListener("pointercancel", (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    blockEvent(event);
    gesture = null;
  }, true);

  document.addEventListener("click", (event) => {
    const button = closestTimeButton(event.target);
    if (!button || allowedProgrammaticClick === button) return;
    if (Date.now() <= blockNativeClickUntil) blockEvent(event);
  }, true);
}

if (typeof window !== "undefined") installTaskTimePickerFix();
