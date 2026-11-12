// {{#if (or a b)}}: Handlebars passes its options object last, so it is dropped.
export default function or(...args) {
  return args.slice(0, -1).some(Boolean);
}
