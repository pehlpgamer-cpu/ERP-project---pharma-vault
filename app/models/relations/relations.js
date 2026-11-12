import { defineRelations } from "drizzle-orm";
import { branches } from "../branches.js";
import { users } from "../users.js";
import { roles } from "../roles.js";
import { permissions } from "../permissions.js";
import { userRoles } from "../user-roles.js";
import { rolePermissions } from "../role-permissions.js";
import { productCategories } from "../product-categories.js";
import { manufacturers } from "../manufacturers.js";
import { products } from "../products.js";
import { units } from "../units.js";
import { productUnits } from "../product-units.js";
import { productBarcodes } from "../product-barcodes.js";
import { stockTransfers } from "../stock-transfers.js";
import { auditLogs } from "../audit-logs.js";
import { inventories } from "../inventories.js";
import { inventoryBatches } from "../inventory-batches.js";
import { inventoryMovements } from "../inventory-movements.js";
import { stockTransferItems } from "../stock-transfer-items.js";
import { inventoryAdjustments } from "../inventory-adjustments.js";
import { inventoryAdjustmentItems } from "../inventory-adjustment-items.js";
import { customers } from "../customers.js";
import { cashRegisters } from "../cash-registers.js";
import { cashRegisterSessions } from "../cash-register-sessions.js";
import { sales } from "../sales.js";
import { saleItems } from "../sale-items.js";
import { saleItemBatches } from "../sale-item-batches.js";
import { salePayments } from "../sale-payments.js";
import { cashTransactions } from "../cash-transactions.js";
import { prescribingPhysicians } from "../prescribing-physicians.js";
import { prescriptions } from "../prescriptions.js";
import { prescriptionItems } from "../prescription-items.js";
import { salePrescriptions } from "../sale-prescriptions.js";
import { dispensings } from "../dispensings.js";
import { dispensingItems } from "../dispensing-items.js";
import { salesReturns } from "../sales-returns.js";
import { salesReturnItems } from "../sales-return-items.js";
import { refunds } from "../refunds.js";
import { productPrices } from "../product-prices.js";
import { documentSequences } from "../document-sequences.js";

export const relations = defineRelations(
  {
    branches,
    users,
    roles,
    permissions,
    userRoles,
    rolePermissions,
    productCategories,
    manufacturers,
    products,
    units,
    productUnits,
    productBarcodes,
    stockTransfers,
    auditLogs,
    inventories,
    inventoryBatches,
    inventoryMovements,
    stockTransferItems,
    inventoryAdjustments,
    inventoryAdjustmentItems,
    customers,
    cashRegisters,
    cashRegisterSessions,
    sales,
    saleItems,
    saleItemBatches,
    salePayments,
    cashTransactions,
    prescribingPhysicians,
    prescriptions,
    prescriptionItems,
    salePrescriptions,
    dispensings,
    dispensingItems,
    salesReturns,
    salesReturnItems,
    refunds,
    productPrices,
    documentSequences,
  },
  (r) => {
    return {
      inventoryAdjustments: {
        branch: r.one.branches({
          from: r.inventoryAdjustments.branchId,
          to: r.branches.id,
          optional: false,
        }),
        creator: r.one.users({
          from: r.inventoryAdjustments.createdBy,
          to: r.users.id,
          optional: false,
        }),
        approver: r.one.users({ from: r.inventoryAdjustments.approvedBy, to: r.users.id }),
        items: r.many.inventoryAdjustmentItems({
          from: r.inventoryAdjustments.id,
          to: r.inventoryAdjustmentItems.inventoryAdjustmentId,
        }),
      },
      inventoryAdjustmentItems: {
        adjustment: r.one.inventoryAdjustments({
          from: r.inventoryAdjustmentItems.inventoryAdjustmentId,
          to: r.inventoryAdjustments.id,
          optional: false,
        }),
        batch: r.one.inventoryBatches({
          from: r.inventoryAdjustmentItems.inventoryBatchId,
          to: r.inventoryBatches.id,
          optional: false,
        }),
      },
      customers: {
        sales: r.many.sales({ from: r.customers.id, to: r.sales.customerId }),
        prescriptions: r.many.prescriptions({
          from: r.customers.id,
          to: r.prescriptions.customerId,
        }),
        returns: r.many.salesReturns({ from: r.customers.id, to: r.salesReturns.customerId }),
      },
      cashRegisters: {
        branch: r.one.branches({
          from: r.cashRegisters.branchId,
          to: r.branches.id,
          optional: false,
        }),
        sessions: r.many.cashRegisterSessions({
          from: r.cashRegisters.id,
          to: r.cashRegisterSessions.cashRegisterId,
        }),
      },
      cashRegisterSessions: {
        register: r.one.cashRegisters({
          from: r.cashRegisterSessions.cashRegisterId,
          to: r.cashRegisters.id,
          optional: false,
        }),
        cashier: r.one.users({
          from: r.cashRegisterSessions.cashierId,
          to: r.users.id,
          optional: false,
        }),
        sales: r.many.sales({ from: r.cashRegisterSessions.id, to: r.sales.cashRegisterSessionId }),
        transactions: r.many.cashTransactions({
          from: r.cashRegisterSessions.id,
          to: r.cashTransactions.cashRegisterSessionId,
        }),
      },
      sales: {
        branch: r.one.branches({ from: r.sales.branchId, to: r.branches.id, optional: false }),
        customer: r.one.customers({ from: r.sales.customerId, to: r.customers.id }),
        cashier: r.one.users({ from: r.sales.cashierId, to: r.users.id, optional: false }),
        session: r.one.cashRegisterSessions({
          from: r.sales.cashRegisterSessionId,
          to: r.cashRegisterSessions.id,
          optional: false,
        }),
        items: r.many.saleItems({ from: r.sales.id, to: r.saleItems.saleId }),
        payments: r.many.salePayments({ from: r.sales.id, to: r.salePayments.saleId }),
        salePrescriptions: r.many.salePrescriptions({
          from: r.sales.id,
          to: r.salePrescriptions.saleId,
        }),
        dispensings: r.many.dispensings({ from: r.sales.id, to: r.dispensings.saleId }),
        returns: r.many.salesReturns({ from: r.sales.id, to: r.salesReturns.saleId }),
      },
      saleItems: {
        sale: r.one.sales({ from: r.saleItems.saleId, to: r.sales.id, optional: false }),
        product: r.one.products({
          from: r.saleItems.productId,
          to: r.products.id,
          optional: false,
        }),
        productUnit: r.one.productUnits({
          from: r.saleItems.productUnitId,
          to: r.productUnits.id,
          optional: false,
        }),
        batches: r.many.saleItemBatches({ from: r.saleItems.id, to: r.saleItemBatches.saleItemId }),
        returnItems: r.many.salesReturnItems({
          from: r.saleItems.id,
          to: r.salesReturnItems.saleItemId,
        }),
      },
      saleItemBatches: {
        item: r.one.saleItems({
          from: r.saleItemBatches.saleItemId,
          to: r.saleItems.id,
          optional: false,
        }),
        batch: r.one.inventoryBatches({
          from: r.saleItemBatches.inventoryBatchId,
          to: r.inventoryBatches.id,
          optional: false,
        }),
      },
      salePayments: {
        sale: r.one.sales({ from: r.salePayments.saleId, to: r.sales.id, optional: false }),
      },
      cashTransactions: {
        session: r.one.cashRegisterSessions({
          from: r.cashTransactions.cashRegisterSessionId,
          to: r.cashRegisterSessions.id,
          optional: false,
        }),
        performer: r.one.users({
          from: r.cashTransactions.performedBy,
          to: r.users.id,
          optional: false,
        }),
      },
      prescribingPhysicians: {
        prescriptions: r.many.prescriptions({
          from: r.prescribingPhysicians.id,
          to: r.prescriptions.physicianId,
        }),
      },
      prescriptions: {
        customer: r.one.customers({ from: r.prescriptions.customerId, to: r.customers.id }),
        physician: r.one.prescribingPhysicians({
          from: r.prescriptions.physicianId,
          to: r.prescribingPhysicians.id,
          optional: false,
        }),
        verifier: r.one.users({ from: r.prescriptions.verifiedBy, to: r.users.id }),
        items: r.many.prescriptionItems({
          from: r.prescriptions.id,
          to: r.prescriptionItems.prescriptionId,
        }),
        salePrescriptions: r.many.salePrescriptions({
          from: r.prescriptions.id,
          to: r.salePrescriptions.prescriptionId,
        }),
        dispensings: r.many.dispensings({
          from: r.prescriptions.id,
          to: r.dispensings.prescriptionId,
        }),
      },
      prescriptionItems: {
        prescription: r.one.prescriptions({
          from: r.prescriptionItems.prescriptionId,
          to: r.prescriptions.id,
          optional: false,
        }),
        product: r.one.products({
          from: r.prescriptionItems.productId,
          to: r.products.id,
          optional: false,
        }),
        dispensingItems: r.many.dispensingItems({
          from: r.prescriptionItems.id,
          to: r.dispensingItems.prescriptionItemId,
        }),
      },
      salePrescriptions: {
        sale: r.one.sales({ from: r.salePrescriptions.saleId, to: r.sales.id, optional: false }),
        prescription: r.one.prescriptions({
          from: r.salePrescriptions.prescriptionId,
          to: r.prescriptions.id,
          optional: false,
        }),
      },
      dispensings: {
        prescription: r.one.prescriptions({
          from: r.dispensings.prescriptionId,
          to: r.prescriptions.id,
          optional: false,
        }),
        sale: r.one.sales({ from: r.dispensings.saleId, to: r.sales.id, optional: false }),
        pharmacist: r.one.users({
          from: r.dispensings.pharmacistId,
          to: r.users.id,
          optional: false,
        }),
        items: r.many.dispensingItems({
          from: r.dispensings.id,
          to: r.dispensingItems.dispensingId,
        }),
      },
      dispensingItems: {
        dispensing: r.one.dispensings({
          from: r.dispensingItems.dispensingId,
          to: r.dispensings.id,
          optional: false,
        }),
        prescriptionItem: r.one.prescriptionItems({
          from: r.dispensingItems.prescriptionItemId,
          to: r.prescriptionItems.id,
          optional: false,
        }),
        product: r.one.products({
          from: r.dispensingItems.productId,
          to: r.products.id,
          optional: false,
        }),
      },
      salesReturns: {
        refunds: r.many.refunds({ from: r.salesReturns.id, to: r.refunds.salesReturnId }),
        sale: r.one.sales({ from: r.salesReturns.saleId, to: r.sales.id, optional: false }),
        branch: r.one.branches({
          from: r.salesReturns.branchId,
          to: r.branches.id,
          optional: false,
        }),
        customer: r.one.customers({ from: r.salesReturns.customerId, to: r.customers.id }),
        processor: r.one.users({
          from: r.salesReturns.processedBy,
          to: r.users.id,
          optional: false,
        }),
        approver: r.one.users({ from: r.salesReturns.approvedBy, to: r.users.id }),
        items: r.many.salesReturnItems({
          from: r.salesReturns.id,
          to: r.salesReturnItems.salesReturnId,
        }),
      },
      refunds: {
        salesReturn: r.one.salesReturns({
          from: r.refunds.salesReturnId,
          to: r.salesReturns.id,
          optional: false,
        }),
      },
      salesReturnItems: {
        salesReturn: r.one.salesReturns({
          from: r.salesReturnItems.salesReturnId,
          to: r.salesReturns.id,
          optional: false,
        }),
        saleItem: r.one.saleItems({
          from: r.salesReturnItems.saleItemId,
          to: r.saleItems.id,
          optional: false,
        }),
        batch: r.one.inventoryBatches({
          from: r.salesReturnItems.inventoryBatchId,
          to: r.inventoryBatches.id,
        }),
      },
      inventories: {
        branch: r.one.branches({
          from: r.inventories.branchId,
          to: r.branches.id,
          optional: false,
        }),
        product: r.one.products({
          from: r.inventories.productId,
          to: r.products.id,
          optional: false,
        }),
        batches: r.many.inventoryBatches({
          from: r.inventories.id,
          to: r.inventoryBatches.inventoryId,
        }),
      },
      inventoryBatches: {
        inventory: r.one.inventories({
          from: r.inventoryBatches.inventoryId,
          to: r.inventories.id,
          optional: false,
        }),
        product: r.one.products({
          from: r.inventoryBatches.productId,
          to: r.products.id,
          optional: false,
        }),
        branch: r.one.branches({
          from: r.inventoryBatches.branchId,
          to: r.branches.id,
          optional: false,
        }),
        movements: r.many.inventoryMovements({
          from: r.inventoryBatches.id,
          to: r.inventoryMovements.inventoryBatchId,
        }),
      },
      inventoryMovements: {
        branch: r.one.branches({
          from: r.inventoryMovements.branchId,
          to: r.branches.id,
          optional: false,
        }),
        product: r.one.products({
          from: r.inventoryMovements.productId,
          to: r.products.id,
          optional: false,
        }),
        batch: r.one.inventoryBatches({
          from: r.inventoryMovements.inventoryBatchId,
          to: r.inventoryBatches.id,
          optional: false,
        }),
        performer: r.one.users({
          from: r.inventoryMovements.performedBy,
          to: r.users.id,
          optional: false,
        }),
      },
      stockTransferItems: {
        transfer: r.one.stockTransfers({
          from: r.stockTransferItems.stockTransferId,
          to: r.stockTransfers.id,
          optional: false,
        }),
        product: r.one.products({
          from: r.stockTransferItems.productId,
          to: r.products.id,
          optional: false,
        }),
        sourceBatch: r.one.inventoryBatches({
          from: r.stockTransferItems.sourceInventoryBatchId,
          to: r.inventoryBatches.id,
          optional: false,
        }),
        destinationBatch: r.one.inventoryBatches({
          from: r.stockTransferItems.destinationInventoryBatchId,
          to: r.inventoryBatches.id,
        }),
      },
      productCategories: {
        parent: r.one.productCategories({
          from: r.productCategories.parentId,
          to: r.productCategories.id,
        }),
        children: r.many.productCategories({
          from: r.productCategories.id,
          to: r.productCategories.parentId,
        }),
        products: r.many.products({ from: r.productCategories.id, to: r.products.categoryId }),
      },
      manufacturers: {
        products: r.many.products({ from: r.manufacturers.id, to: r.products.manufacturerId }),
      },
      products: {
        category: r.one.productCategories({
          from: r.products.categoryId,
          to: r.productCategories.id,
        }),
        manufacturer: r.one.manufacturers({
          from: r.products.manufacturerId,
          to: r.manufacturers.id,
        }),
        productUnits: r.many.productUnits({ from: r.products.id, to: r.productUnits.productId }),
      },
      units: {
        productUnits: r.many.productUnits({ from: r.units.id, to: r.productUnits.unitId }),
      },
      productUnits: {
        product: r.one.products({
          from: r.productUnits.productId,
          to: r.products.id,
          optional: false,
        }),
        unit: r.one.units({ from: r.productUnits.unitId, to: r.units.id, optional: false }),
        barcodes: r.many.productBarcodes({
          from: r.productUnits.id,
          to: r.productBarcodes.productUnitId,
        }),
        prices: r.many.productPrices({
          from: r.productUnits.id,
          to: r.productPrices.productUnitId,
        }),
      },
      productBarcodes: {
        productUnit: r.one.productUnits({
          from: r.productBarcodes.productUnitId,
          to: r.productUnits.id,
          optional: false,
        }),
      },
      productPrices: {
        productUnit: r.one.productUnits({
          from: r.productPrices.productUnitId,
          to: r.productUnits.id,
          optional: false,
        }),
        branch: r.one.branches({ from: r.productPrices.branchId, to: r.branches.id }),
      },
      stockTransfers: {
        items: r.many.stockTransferItems({
          from: r.stockTransfers.id,
          to: r.stockTransferItems.stockTransferId,
        }),
        sourceBranch: r.one.branches({
          from: r.stockTransfers.sourceBranchId,
          to: r.branches.id,
          optional: false,
        }),
        destinationBranch: r.one.branches({
          from: r.stockTransfers.destinationBranchId,
          to: r.branches.id,
          optional: false,
        }),
        requester: r.one.users({
          from: r.stockTransfers.requestedBy,
          to: r.users.id,
          optional: false,
        }),
        approver: r.one.users({ from: r.stockTransfers.approvedBy, to: r.users.id }),
      },
      auditLogs: {
        user: r.one.users({ from: r.auditLogs.userId, to: r.users.id }),
        branch: r.one.branches({ from: r.auditLogs.branchId, to: r.branches.id }),
      },
      branches: {
        users: r.many.users({ from: r.branches.id, to: r.users.branchId }),
      },
      users: {
        branch: r.one.branches({ from: r.users.branchId, to: r.branches.id }),
        userRoles: r.many.userRoles({ from: r.users.id, to: r.userRoles.userId }),
      },
      roles: {
        userRoles: r.many.userRoles({ from: r.roles.id, to: r.userRoles.roleId }),
        rolePermissions: r.many.rolePermissions({ from: r.roles.id, to: r.rolePermissions.roleId }),
      },
      permissions: {
        rolePermissions: r.many.rolePermissions({
          from: r.permissions.id,
          to: r.rolePermissions.permissionId,
        }),
      },
      userRoles: {
        user: r.one.users({ from: r.userRoles.userId, to: r.users.id, optional: false }),
        role: r.one.roles({ from: r.userRoles.roleId, to: r.roles.id, optional: false }),
      },
      rolePermissions: {
        role: r.one.roles({ from: r.rolePermissions.roleId, to: r.roles.id, optional: false }),
        permission: r.one.permissions({
          from: r.rolePermissions.permissionId,
          to: r.permissions.id,
          optional: false,
        }),
      },
    };
  },
);
