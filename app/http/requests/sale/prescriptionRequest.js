// Shapes what a browser sends for prescriptions into the plain input the prescription service validates.
import { rowsOf } from "../purchasing/purchasingRequest.js";

const str = (value) => {
  return typeof value === "string" ? value : undefined;
};

export function recordRequest(body) {
  return {
    physician: {
      fullName: str(body?.physicianName),
      licenseNumber: str(body?.licenseNumber),
      specialization: str(body?.specialization),
      contactNumber: str(body?.contactNumber),
    },
    customerNumber: str(body?.customerNumber),
    prescriptionDate: str(body?.prescriptionDate),
    validUntil: str(body?.validUntil),
    items: rowsOf(body?.items).map((row) => {
      return {
        sku: str(row.sku),
        prescribedQuantity: str(row.prescribedQuantity),
        dosageInstructions: str(row.dosageInstructions),
        frequency: str(row.frequency),
        duration: str(row.duration),
      };
    }),
  };
}

export function prescriptionListRequest(query) {
  const page = Number.parseInt(str(query?.page) ?? "1", 10);

  return {
    status: str(query?.status),
    q: str(query?.q) ?? "",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}
