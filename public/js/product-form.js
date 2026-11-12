// Product form: adds and removes unit rows. The server validates everything; without this script the
// form still works with the rows it was rendered with. Rows are cloned from the <template> and never
// built from markup strings.

const rows = document.getElementById("unit-rows");
const template = document.getElementById("unit-row-template");
const addButton = document.getElementById("add-unit");

if (rows && template && addButton) {
  let nextIndex = Number(rows.dataset.nextIndex) || rows.children.length;

  const renumber = (node, index) => {
    for (const element of node.querySelectorAll("[name]")) {
      element.setAttribute(
        "name",
        element.getAttribute("name").replace("__INDEX__", String(index)),
      );
    }
  };

  // Keeps at least one row: the last one cannot be removed.
  const refreshRemoveButtons = () => {
    const only = rows.querySelectorAll("[data-unit-row]").length <= 1;

    for (const button of rows.querySelectorAll("[data-remove-unit]")) {
      button.disabled = only;
    }
  };

  addButton.addEventListener("click", () => {
    const fragment = template.content.cloneNode(true);

    renumber(fragment, nextIndex);
    nextIndex += 1;
    rows.append(fragment);
    refreshRemoveButtons();
  });

  rows.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-unit]");

    if (!button || button.disabled) {
      return;
    }

    button.closest("[data-unit-row]").remove();
    refreshRemoveButtons();
  });

  refreshRemoveButtons();
}
