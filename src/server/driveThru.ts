/**
 * McDonald's Drive-Thru Menu, Order POS State Machine, and Gemini Tool Definitions.
 *
 * To adapt this starter to your own business (hotel desk, clinic booking, retail CRM),
 * swap this single file and update `src/server/prompts.ts`.
 */

import { Type, type FunctionDeclaration, type Schema, type Tool } from "@google/genai";
import type { MenuItem, OrderLine, OrderSnapshot } from "../shared/types.ts";

const TAX_RATE = 0.0825;

export const MENU_CATALOG: MenuItem[] = [
  { id: "big_mac", name: "Big Mac", category: "Burgers", daypart: "regular", price: 5.99, meal_add: 3.5 },
  { id: "qpc", name: "Quarter Pounder with Cheese", category: "Burgers", daypart: "regular", price: 6.39, meal_add: 3.5 },
  { id: "double_qpc", name: "Double Quarter Pounder with Cheese", category: "Burgers", daypart: "regular", price: 7.89, meal_add: 3.5 },
  { id: "mcdouble", name: "McDouble", category: "Burgers", daypart: "regular", price: 3.19, meal_add: 3.2 },
  { id: "cheeseburger", name: "Cheeseburger", category: "Burgers", daypart: "regular", price: 2.49, meal_add: 3.2 },
  { id: "mcchicken", name: "McChicken", category: "Chicken & Fish", daypart: "regular", price: 3.19, meal_add: 3.2 },
  { id: "mccrispy", name: "McCrispy", category: "Chicken & Fish", daypart: "regular", price: 5.69, meal_add: 3.5 },
  { id: "spicy_mccrispy", name: "Spicy McCrispy", category: "Chicken & Fish", daypart: "regular", price: 5.89, meal_add: 3.5 },
  { id: "filet_o_fish", name: "Filet-O-Fish", category: "Chicken & Fish", daypart: "regular", price: 5.49, meal_add: 3.5 },
  { id: "mcnuggets_6", name: "6 Piece Chicken McNuggets", category: "Chicken & Fish", daypart: "regular", price: 3.99, meal_add: 3.2 },
  { id: "mcnuggets_10", name: "10 Piece Chicken McNuggets", category: "Chicken & Fish", daypart: "regular", price: 5.79, meal_add: 3.5 },
  { id: "mcnuggets_20", name: "20 Piece Chicken McNuggets", category: "Chicken & Fish", daypart: "regular", price: 8.99, meal_add: 0 },
  { id: "egg_mcmuffin", name: "Egg McMuffin", category: "Breakfast", daypart: "breakfast", price: 4.79, meal_add: 2.8 },
  { id: "sausage_mcmuffin_egg", name: "Sausage McMuffin with Egg", category: "Breakfast", daypart: "breakfast", price: 4.99, meal_add: 2.8 },
  { id: "bacon_egg_cheese_biscuit", name: "Bacon, Egg & Cheese Biscuit", category: "Breakfast", daypart: "breakfast", price: 4.89, meal_add: 2.8 },
  { id: "sausage_mcgriddles", name: "Sausage, Egg & Cheese McGriddles", category: "Breakfast", daypart: "breakfast", price: 5.29, meal_add: 2.8 },
  { id: "hotcakes", name: "Hotcakes", category: "Breakfast", daypart: "breakfast", price: 4.39, meal_add: 0 },
  { id: "hash_browns", name: "Hash Browns", category: "Sides", daypart: "breakfast", price: 2.39, meal_add: 0 },
  { id: "fries", name: "French Fries", category: "Sides", daypart: "regular", price: 3.29, sizes: { small: 2.49, medium: 3.29, large: 3.99 } },
  { id: "oreo_mcflurry", name: "Oreo McFlurry", category: "Sweets", daypart: "all", price: 4.39 },
  { id: "apple_pie", name: "Baked Apple Pie", category: "Sweets", daypart: "all", price: 1.89 },
  { id: "vanilla_shake", name: "Vanilla Shake", category: "Sweets", daypart: "all", price: 3.99, sizes: { small: 3.49, medium: 3.99, large: 4.49 } },
  { id: "chocolate_shake", name: "Chocolate Shake", category: "Sweets", daypart: "all", price: 3.99, sizes: { small: 3.49, medium: 3.99, large: 4.49 } },
  { id: "coke", name: "Coca-Cola", category: "Drinks", daypart: "all", price: 1.79, sizes: { small: 1.49, medium: 1.79, large: 2.19 } },
  { id: "diet_coke", name: "Diet Coke", category: "Drinks", daypart: "all", price: 1.79, sizes: { small: 1.49, medium: 1.79, large: 2.19 } },
  { id: "sprite", name: "Sprite", category: "Drinks", daypart: "all", price: 1.79, sizes: { small: 1.49, medium: 1.79, large: 2.19 } },
  { id: "dr_pepper", name: "Dr Pepper", category: "Drinks", daypart: "all", price: 1.79, sizes: { small: 1.49, medium: 1.79, large: 2.19 } },
  { id: "coffee", name: "Premium Roast Coffee", category: "Drinks", daypart: "all", price: 1.99, sizes: { small: 1.59, medium: 1.99, large: 2.39 } },
  { id: "iced_coffee", name: "Iced Coffee", category: "Drinks", daypart: "all", price: 2.69, sizes: { small: 2.29, medium: 2.69, large: 3.09 } },
  { id: "orange_juice", name: "Orange Juice", category: "Drinks", daypart: "all", price: 2.89 },
];

const SAY_SCHEMA: Schema = {
  type: Type.STRING,
  description:
    "Optional short natural phrase (3 to 7 words) spoken immediately while this tool executes so the guest is not left in silence, e.g. 'Got it, adding that now.' Leave empty if you already spoke.",
};

export function getGeminiTools(): Tool {
  const declarations: FunctionDeclaration[] = [
    {
      name: "add_item",
      description: "Add an item to the guest's order.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING, description: "Menu item name, e.g. 'Big Mac', '10 Piece McNuggets', 'Coca-Cola'" },
          qty: { type: Type.INTEGER, description: "Quantity (default 1)" },
          size: { type: Type.STRING, description: "small, medium, or large" },
          meal: { type: Type.BOOLEAN, description: "True to make it a combo meal with side and drink" },
          drink: { type: Type.STRING, description: "Drink choice when meal=true, e.g. 'Coke', 'Sprite'" },
          modifiers: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Customizations such as 'no pickles', 'extra cheese', 'no ice'",
          },
          say: SAY_SCHEMA,
        },
        required: ["item"],
      },
    },
    {
      name: "update_item",
      description: "Update an existing order line by 1-based line number.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          line: { type: Type.INTEGER, description: "1-based line number on the order board" },
          qty: { type: Type.INTEGER },
          size: { type: Type.STRING },
          meal: { type: Type.BOOLEAN },
          drink: { type: Type.STRING },
          modifiers: { type: Type.ARRAY, items: { type: Type.STRING } },
          say: SAY_SCHEMA,
        },
        required: ["line"],
      },
    },
    {
      name: "remove_item",
      description: "Remove a line from the guest's order.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          line: { type: Type.INTEGER, description: "1-based line number to remove" },
          say: SAY_SCHEMA,
        },
        required: ["line"],
      },
    },
    {
      name: "get_order",
      description: "Retrieve all current order lines, subtotal, tax, and total before reading back.",
      parameters: { type: Type.OBJECT, properties: { say: SAY_SCHEMA } },
    },
    {
      name: "lookup_menu",
      description: "Search available menu items and prices for the active daypart.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: "Category or keyword to search, or empty for all" },
          say: SAY_SCHEMA,
        },
      },
    },
    {
      name: "confirm_order",
      description: "Finalize and confirm the order once the guest approves the read-back.",
      parameters: { type: Type.OBJECT, properties: { say: SAY_SCHEMA } },
    },
    {
      name: "cancel_order",
      description: "Clear all items from the order if the guest cancels.",
      parameters: { type: Type.OBJECT, properties: { say: SAY_SCHEMA } },
    },
  ];
  return { functionDeclarations: declarations };
}

function matchMenuItem(query: string): MenuItem | undefined {
  const q = query.trim().toLowerCase();
  const aliases: Record<string, string> = {
    coke: "coke",
    "coca cola": "coke",
    fries: "fries",
    "french fries": "fries",
    nuggets: "mcnuggets_10",
    mcnuggets: "mcnuggets_10",
    "6 piece": "mcnuggets_6",
    "6 pc": "mcnuggets_6",
    "10 piece": "mcnuggets_10",
    "10 pc": "mcnuggets_10",
    "20 piece": "mcnuggets_20",
    "quarter pounder": "qpc",
    "double quarter pounder": "double_qpc",
    mcflurry: "oreo_mcflurry",
    mcgriddle: "sausage_mcgriddles",
  };
  if (aliases[q]) {
    return MENU_CATALOG.find((m) => m.id === aliases[q]);
  }
  return (
    MENU_CATALOG.find((m) => m.name.toLowerCase() === q || m.id === q) ??
    MENU_CATALOG.find((m) => q.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(q))
  );
}

export const READ_ONLY_TOOLS = new Set(["lookup_menu", "get_order"]);

export class DriveThruOrderState {
  public daypart: "regular" | "breakfast" = "regular";
  public status: "open" | "confirmed" | "cancelled" = "open";
  public orderNumber = 142;
  public lines: OrderLine[] = [];

  public reset(): void {
    this.lines = [];
    this.status = "open";
    this.orderNumber += 1;
  }

  private computeUnitPrice(entry: MenuItem, size: string, meal: boolean): number {
    const sz = (size || "medium").toLowerCase();
    let base = entry.sizes?.[sz] ?? entry.price;
    if (meal && (entry.meal_add ?? 0) > 0) {
      base += entry.meal_add ?? 0;
      if (sz === "large") base += 1.0;
    }
    return Math.round(base * 100) / 100;
  }

  public snapshot(): OrderSnapshot {
    const subtotal = Math.round(this.lines.reduce((acc, l) => acc + l.line_total, 0) * 100) / 100;
    const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    return {
      daypart: this.daypart,
      status: this.status,
      order_number: this.orderNumber,
      lines: this.lines.map((l) => ({ ...l, modifiers: [...l.modifiers] })),
      subtotal,
      tax,
      total,
    };
  }

  public executeTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (name === "lookup_menu") {
      const q = String(args.query ?? "").trim().toLowerCase();
      const items = MENU_CATALOG.filter(
        (m) =>
          (m.daypart === "all" || m.daypart === this.daypart) &&
          (!q || m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)),
      ).map((m) => ({
        name: m.name,
        category: m.category,
        price: m.price,
        meal_available: Boolean((m.meal_add ?? 0) > 0),
      }));
      return { ok: true, daypart: this.daypart, items };
    }

    if (name === "add_item") {
      const rawItem = String(args.item ?? "");
      const entry = matchMenuItem(rawItem);
      if (!entry) {
        return { ok: false, error: `Unknown menu item '${rawItem}'. Use lookup_menu to check items.` };
      }
      if (entry.daypart !== "all" && entry.daypart !== this.daypart) {
        return { ok: false, error: `${entry.name} is only served during ${entry.daypart}.` };
      }
      const qty = Math.max(1, Number(args.qty ?? 1));
      const size = String(args.size ?? "medium").toLowerCase();
      const meal = Boolean(args.meal) && Boolean((entry.meal_add ?? 0) > 0);
      const drink = String(args.drink ?? (meal ? "Coca-Cola" : ""));
      const modifiers = Array.isArray(args.modifiers)
        ? args.modifiers.map((x) => String(x)).filter(Boolean)
        : [];
      const unitPrice = this.computeUnitPrice(entry, size, meal);
      const lineObj: OrderLine = {
        line: this.lines.length + 1,
        item_id: entry.id,
        name: entry.name,
        qty,
        size,
        meal,
        drink,
        modifiers,
        unit_price: unitPrice,
        line_total: Math.round(unitPrice * qty * 100) / 100,
      };
      this.lines.push(lineObj);
      this.status = "open";
      return {
        ok: true,
        added: lineObj,
        ask_for_drink: meal && !args.drink,
        order: this.snapshot(),
      };
    }

    if (name === "update_item") {
      const idx = Number(args.line ?? 0) - 1;
      const target = this.lines[idx];
      if (!target) {
        return { ok: false, error: `Line ${idx + 1} does not exist.` };
      }
      const entry = MENU_CATALOG.find((m) => m.id === target.item_id) ?? MENU_CATALOG[0];
      if (args.qty !== undefined) target.qty = Math.max(1, Number(args.qty));
      if (args.size) target.size = String(args.size).toLowerCase();
      if (args.meal !== undefined) target.meal = Boolean(args.meal) && Boolean((entry.meal_add ?? 0) > 0);
      if (args.drink !== undefined) target.drink = String(args.drink);
      if (Array.isArray(args.modifiers)) {
        target.modifiers = args.modifiers.map((x) => String(x)).filter(Boolean);
      }
      target.unit_price = this.computeUnitPrice(entry, target.size, target.meal);
      target.line_total = Math.round(target.unit_price * target.qty * 100) / 100;
      return { ok: true, updated: target, order: this.snapshot() };
    }

    if (name === "remove_item") {
      const idx = Number(args.line ?? 0) - 1;
      if (idx < 0 || idx >= this.lines.length) {
        return { ok: false, error: `Line ${idx + 1} does not exist.` };
      }
      const [removed] = this.lines.splice(idx, 1);
      this.lines.forEach((l, i) => {
        l.line = i + 1;
      });
      return { ok: true, removed: removed.name, order: this.snapshot() };
    }

    if (name === "get_order") {
      return { ok: true, order: this.snapshot() };
    }

    if (name === "confirm_order") {
      if (this.lines.length === 0) {
        return { ok: false, error: "Cannot confirm an empty order." };
      }
      this.status = "confirmed";
      return { ok: true, confirmed: true, window: "first window", order: this.snapshot() };
    }

    if (name === "cancel_order") {
      this.lines = [];
      this.status = "cancelled";
      return { ok: true, cancelled: true, order: this.snapshot() };
    }

    return { ok: false, error: `Unknown tool '${name}'` };
  }
}
