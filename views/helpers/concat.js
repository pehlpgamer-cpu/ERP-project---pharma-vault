// {{> components/stat-card hint=(concat "Yesterday " (currency yesterday))}}: joins its arguments.
// Handlebars passes its options object last, so it is dropped.
export default function concat(...args) {
  return args.slice(0, -1).join("");
}
