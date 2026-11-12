// {{#if (gt total 0)}}: numeric comparison (display only; money logic never runs in templates).
export default function gt(a, b) {
  return Number(a) > Number(b);
}
