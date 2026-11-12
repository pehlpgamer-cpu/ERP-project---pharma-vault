// {{#if (and a b)}}: Handlebars passes its options object last, so it is dropped.
export default function and(...args) {
  return args.slice(0, -1).every(Boolean);
}
