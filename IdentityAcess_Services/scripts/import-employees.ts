#!/usr/bin/env bun
/**
 * Imports the HR registry of existing employees.
 *
 * Existing employees can only sign up after their employee number, national ID
 * and personal details have been loaded here. The API equivalent is
 * `POST /api/v1/admin/employees/import` (permission `employees:import`).
 *
 * Usage:
 *   bun run scripts/import-employees.ts ./data/employees.json
 *   bun run scripts/import-employees.ts ./data/employees.csv
 *
 * Supported formats:
 *   - JSON: an array of objects, or `{ "employees": [ ... ] }`
 *   - CSV:  header row using the same field names as the JSON objects
 *
 * Required fields: employee_id, employee_number, full_name, phone, national_id_number
 * Optional fields: email, department, position
 */

import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { connectDatabase, disconnectDatabase } from "../Config/db.ts";
import EmployeeRecordModel from "../Models/EmployeeRecordSchema.ts";
import UserModel from "../Models/UserSchema.ts";
import { hashNationalId } from "../Utils/crypto.ts";
import {
  employeeIdentifierField,
  fullNameField,
  nationalIdField,
  normalisePhone,
  optionalEmail,
  optionalString,
  phoneField,
  type JsonBody,
} from "../Utils/validation.ts";

interface ImportRow {
  employee_id: string;
  employee_number: string;
  full_name: string;
  phone: string;
  email?: string;
  national_id_hash: string;
  national_id_last4: string;
  department?: string;
  position?: string;
}

interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

function parseCsv(text: string): JsonBody[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...dataRows] = rows;
  if (!header) return [];

  const columns = header.map((column) => column.trim());
  return dataRows
    .filter((values) => values.some((value) => value.trim().length > 0))
    .map((values) => {
      const output: JsonBody = {};
      columns.forEach((column, index) => {
        output[column] = values[index]?.trim() ?? "";
      });
      return output;
    });
}

async function loadRows(path: string): Promise<JsonBody[]> {
  const text = await readFile(path, "utf8");
  const extension = extname(path).toLowerCase();

  if (extension === ".csv") return parseCsv(text);

  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as JsonBody[];
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { employees?: unknown }).employees)
  ) {
    return (parsed as { employees: JsonBody[] }).employees;
  }

  throw new Error("JSON file must contain an array or an { employees: [...] } object");
}

function rowToRecord(raw: unknown, index: number): ImportRow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`row ${index + 1}: expected an object`);
  }

  const body = raw as JsonBody;
  const employeeId = employeeIdentifierField(body, "employee_id", "employee_id");
  const employeeNumber = employeeIdentifierField(body, "employee_number", "employee_number");
  const fullName = fullNameField(body);
  const phone = phoneField(body);
  const email = optionalEmail(body);
  const nationalId = nationalIdField(body, ["national_id_number", "national_id"]);
  const department = optionalString(body, "department", { max: 120, label: "department" });
  const position = optionalString(body, "position", { max: 120, label: "position" });

  // Guard against accidentally importing a blank phone from CSV padding.
  if (normalisePhone(phone).length < 7) {
    throw new Error(`row ${index + 1}: phone is too short`);
  }

  return {
    employee_id: employeeId,
    employee_number: employeeNumber,
    full_name: fullName,
    phone: normalisePhone(phone),
    ...(email ? { email } : {}),
    national_id_hash: hashNationalId(nationalId),
    national_id_last4: nationalId.slice(-4),
    ...(department ? { department } : {}),
    ...(position ? { position } : {}),
  };
}

async function importRow(record: ImportRow, summary: ImportSummary): Promise<void> {
  const userConflict = await UserModel.exists({
    deleted_at: null,
    $or: [
      { employee_number: record.employee_number },
      { employee_id: record.employee_id },
      { phone: record.phone },
      { national_id_hash: record.national_id_hash },
    ],
  });

  if (userConflict) {
    summary.skipped += 1;
    console.warn(
      `- skipped ${record.employee_number}: a user account already exists for this employee`,
    );
    return;
  }

  const existing = await EmployeeRecordModel.findOne({
    employee_number: record.employee_number,
  });

  if (existing) {
    if (existing.status === "registered" || existing.user_id) {
      summary.skipped += 1;
      console.warn(`- skipped ${record.employee_number}: employee record is already registered`);
      return;
    }

    const conflict = await EmployeeRecordModel.findOne({
      employee_number: { $ne: record.employee_number },
      $or: [
        { employee_id: record.employee_id },
        { national_id_hash: record.national_id_hash },
      ],
    });
    if (conflict) {
      throw new Error(
        `employee_id or national ID already belongs to ${conflict.employee_number}`,
      );
    }

    existing.employee_id = record.employee_id;
    existing.full_name = record.full_name;
    existing.phone = record.phone;
    existing.email = record.email ?? null;
    existing.national_id_hash = record.national_id_hash;
    existing.national_id_last4 = record.national_id_last4;
    existing.department = record.department ?? null;
    existing.position = record.position ?? null;
    await existing.save();
    summary.updated += 1;
    console.log(`- updated ${record.employee_number}`);
    return;
  }

  const conflict = await EmployeeRecordModel.findOne({
    $or: [
      { employee_id: record.employee_id },
      { national_id_hash: record.national_id_hash },
    ],
  });
  if (conflict) {
    throw new Error(
      `employee_id or national ID already belongs to ${conflict.employee_number}`,
    );
  }

  await EmployeeRecordModel.create({ ...record, status: "available" });
  summary.created += 1;
  console.log(`- created ${record.employee_number}`);
}

async function main(): Promise<void> {
  const fileArgument = process.argv[2];
  if (!fileArgument) {
    console.error(
      "Usage: bun run scripts/import-employees.ts <employees.json|employees.csv>",
    );
    process.exitCode = 1;
    return;
  }

  const path = resolve(fileArgument);
  const rows = await loadRows(path);
  if (rows.length === 0) {
    console.error("No employee rows found in the input file");
    process.exitCode = 1;
    return;
  }

  await connectDatabase();

  const summary: ImportSummary = { created: 0, updated: 0, skipped: 0, failed: 0 };

  try {
    for (let index = 0; index < rows.length; index += 1) {
      try {
        const record = rowToRecord(rows[index], index);
        await importRow(record, summary);
      } catch (error) {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`- failed row ${index + 1}: ${message}`);
      }
    }
  } finally {
    await disconnectDatabase();
  }

  console.log("");
  console.log(
    `Import finished: ${summary.created} created, ${summary.updated} updated, ` +
      `${summary.skipped} skipped, ${summary.failed} failed (${rows.length} rows)`,
  );

  if (summary.failed > 0) process.exitCode = 1;
}

await main();
