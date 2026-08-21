// ═══════════════════════════════════════════════════════════════════════════
// flow ที่ 1: แจ้งหัวหน้าให้อนุมัติใบคำขอ (การ์ด Teams + อีเมล)
//
// ยิงตอน submitRequest — ผู้รับคือหัวหน้าแผนกของผู้ขอซื้อบน PO
//
// ★ คนละ flow กับ sendToRequester.ts จึงคนละ URL: บน Power Automate เป็นคนละ flow ที่มี
//   trigger คนละอัน (อันนี้มี Adaptive Card ที่รอคนกดปุ่มแล้วยิงกลับมาที่ /webhook ของเรา
//   ส่วนอันนั้นเป็นอีเมลทางเดียว) ส่ง payload ข้ามกันไม่ได้ และ flow ปลายทางจะตอบ 200
//   กลับมาเฉย ๆ โดยไม่มีอะไรเกิดขึ้น ซึ่งเป็นอาการที่หาสาเหตุยากที่สุด
// ═══════════════════════════════════════════════════════════════════════════
import { env } from '@config/env';
import { esc, postToFlow, thaiDateTime, type SendResult } from './shared';

/**
 * URL ของ flow ขออนุมัติ — อ่านตอนเรียกไม่ใช่ตอน import
 *
 * เก็บเป็น const ระดับโมดูลจะได้ค่า ณ ตอนโหลดไฟล์ ซึ่งอ่านยากว่าทำไมแก้ .env แล้วยังไม่เปลี่ยน
 * (ต้องรีสตาร์ท) และทำให้เทสต์ที่สลับ env ไม่ได้ผล
 *
 * ยังใช้ชื่อ POWER_AUTOMATE_URL ตามเดิมโดยตั้งใจ ไม่เปลี่ยนเป็น ..._MANAGER_URL: เครื่อง
 * production มี .env ของตัวเองที่เราแก้จากที่นี่ไม่ได้ เปลี่ยนชื่อ = ค่าเดิมไม่ถูกอ่าน แล้ว
 * default '' จะทำให้การ์ดขออนุมัติเงียบไปทั้งระบบโดยไม่มี error (postToFlow ตอบ 503 เฉย ๆ)
 */
function managerFlowUrl(): string {
  return env.POWER_AUTOMATE_URL.trim();
}

export type ApprovalRequest = {
  requestId: number;
  /** employee.id ของหัวหน้า — flow ต้องส่งกลับมาที่ /webhook เป็น approvedBy */
  managerId: number;
  /** ชื่อเต็มหัวหน้า — frontend ประกอบ firstName + lastName มาให้แล้ว */
  managerName: string;
  /** ปลายทางจริงที่ Power Automate ใช้ส่ง */
  managerEmail: string;
  /** ผู้ขอซื้อบน PO (OPOR.OwnerCode) — แสดงเป็น OwnerPR */
  ownerPrName: string;
  /** คนกดส่งคำขอใน AMS — แสดงเป็น RequestBy คนละคนกับ ownerPrName ได้ */
  requestBy: string;
  /**
   * อีเมลของคนกดส่งคำขอ — flow ใช้เป็นปลายทางตอนแจ้งผลกลับหลัง condition action = Approved
   *
   * null = ผู้ส่งคำขอไม่มีอีเมลในข้อมูลพนักงาน → flow ต้อง "ข้ามขั้นส่งเมล" ไม่ใช่ส่งไปหาค่าว่าง
   * (ธรรมเนียมเดียวกับ toManager/toRequester ของ sendRegisteredNotice: AMS เป็นคนตัดสิน
   * ผู้รับเสมอ ช่องที่ไม่มีผู้รับส่งเป็น null ไม่ใช่สตริงว่าง)
   *
   * ไม่บล็อกการส่งการ์ด: การ์ดขออนุมัติเป็นคนละเรื่องกับเมลแจ้งผล ผู้ขอไม่มีอีเมลไม่ควร
   * ทำให้หัวหน้าไม่ได้รับใบ
   */
  requestByEmail: string | null;
  poNumber: string;
  vendorName: string;
  poDate: string;

  /**
   * ใบนี้เคยถูกตีกลับมาก่อนหรือไม่ — null = ส่งครั้งแรก
   *
   * ส่งได้ใบเดียวจากสองสถานะ (DRAFT/REJECTED) ดังนั้น "มี rejectedAt ตอนส่ง" = ผู้ขอแก้แล้ว
   * ส่งกลับมาใหม่ ผู้อนุมัติต้องรู้ตั้งแต่บนการ์ดว่านี่คือรอบสอง ไม่ใช่ใบใหม่ที่เพิ่งเห็นครั้งแรก —
   * ไม่งั้นต้องเปิดระบบไปไล่ดูเองว่าเคยตีกลับด้วยเหตุผลอะไรและแก้มาแล้วหรือยัง
   */
  previousRejection: {
    /** ISO ตอนถูกตีกลับครั้งล่าสุด */
    at: string;
    /** ชื่อคนที่ตีกลับ */
    by: string;
    /** role ณ ตอนกด — ตีกลับทั้งใบไม่ได้มาจากหัวหน้าเสมอไป (MANAGER/FINANCE/ADMIN) */
    role: string;
    reason: string;
  } | null;

  grpo: {
    grpoNumber: string;
    item: {
      poLine: string;
      description: string;
      quantity: number;
      serialItems: {
        serialNumber: string;
        pricePerUnit: number;
        // 📍 location อยู่ระดับชิ้น ไม่ใช่ระดับ item — ของในบรรทัดเดียวกันไปคนละที่ได้
        // frontend ประกอบ "ที่ตั้ง - ตำแหน่งย่อย" มาให้แล้ว
        location: string;
      }[];
    }[];
  }[];
};

function buildApprovalEmailHtml(data: ApprovalRequest): string {
  const grpoHtml = data.grpo
    .map(
      (grpo) => `
        <h3 style="margin-top: 24px;">
          GRPO: ${grpo.grpoNumber}
        </h3>
        <table
          border="1"
          cellpadding="6"
          cellspacing="0"
          style="
            border-collapse: collapse;
            width: 100%;
            font-family: Arial, sans-serif;
            font-size: 14px;
          "
        >
          <thead>
            <tr style="background-color: #f2f2f2;">
              <th>PO Line</th>
              <th>Description</th>
              <th>Serial Number</th>
              <th>Price / Unit</th>
              <th>Location</th> <!-- 📍 เพิ่มหัวตาราง Location -->
            </tr>
          </thead>
          <tbody>
            ${grpo.item
              .map((item) =>
                item.serialItems
                  .map(
                    (serial) => `
                      <tr>
                        <td>${item.poLine}</td>
                        <td>${item.description}</td>
                        <td>${serial.serialNumber}</td>
                        <td>
                          ${serial.pricePerUnit.toLocaleString()}
                        </td>
                        <td>${serial.location}</td> <!-- 📍 รายชิ้น ไม่ใช่รวมทั้งบรรทัด -->
                      </tr>
                    `
                  )
                  .join('')
              )
              .join('')}
          </tbody>
        </table>
      `
    )
    .join('');

  return `
    <!DOCTYPE html>
    <html>
      <body
        style="
          font-family: Arial, sans-serif;
          color: #333;
          line-height: 1.5;
        "
      >
        <h2>Purchase Order Approval</h2>
        ${
          data.previousRejection
            ? `<div style="
                 border-left: 4px solid #d97706;
                 background: #fef3c7;
                 padding: 12px 16px;
                 margin-bottom: 20px;
               ">
                 <strong>⚠️ ใบนี้เคยถูกตีกลับ และผู้ขอแก้ไขแล้วส่งกลับมาใหม่</strong>
                 <div style="margin-top: 6px; font-size: 13px;">
                   ตีกลับโดยคุณ ${esc(data.previousRejection.by)}
                   (${esc(data.previousRejection.role)})
                   เมื่อ ${esc(thaiDateTime(data.previousRejection.at))}
                 </div>
                 <div style="margin-top: 4px; font-size: 13px;">
                   เหตุผลเดิม: ${esc(data.previousRejection.reason)}
                 </div>
               </div>`
            : ''
        }
        <table
          cellpadding="6"
          cellspacing="0"
          style="
            border-collapse: collapse;
            margin-bottom: 20px;
          "
        >
          <tr>
            <td><strong>Request ID</strong></td>
            <td>${data.requestId}</td>
          </tr>
          <tr>
            <td><strong>Manager</strong></td>
            <td>${data.managerName}</td>
          </tr>
          <tr>
            <td><strong>Owner PR</strong></td>
            <td>${data.ownerPrName}</td>
          </tr>
          <tr>
            <td><strong>Request By</strong></td>
            <td>${data.requestBy}</td>
          </tr>
          <tr>
            <td><strong>PO Number</strong></td>
            <td>${data.poNumber}</td>
          </tr>
          <tr>
            <td><strong>Vendor</strong></td>
            <td>${data.vendorName}</td>
          </tr>
          <tr>
            <td><strong>PO Date</strong></td>
            <td>${data.poDate}</td>
          </tr>
        </table>
        <hr />
        ${grpoHtml}
      </body>
    </html>
  `;
}

// =========================
// Build Adaptive Card JSON
// =========================

function buildAdaptiveCard(data: ApprovalRequest): object {
  // 1. ส่วนหัวของ Card และ ข้อมูลทั่วไป
  const cardBody: any[] = [
    {
      type: "TextBlock",
      text: "📝 ขออนุมัติรายการใหม่ (PO / GRPO)",
      weight: "Bolder",
      size: "Medium"
    },
    {
      type: "TextBlock",
      text: "กรุณาตรวจสอบข้อมูลและพิจารณาอนุมัติ",
      wrap: true,
      spacing: "None"
    },
  ];

  // ป้าย "รอบสอง" — วางไว้เหนือรายการของ ไม่ใช่ท้ายการ์ด เพราะมันเปลี่ยนวิธีอ่านทั้งใบ
  // (ผู้อนุมัติต้องรู้ว่าต้องดูว่าแก้ตามที่เคยสั่งไว้แล้วหรือยัง ไม่ใช่ตรวจเหมือนใบใหม่)
  // style "attention" = แถบแดงของ Adaptive Cards ตัวเดียวที่เตะตาพอโดยไม่ต้องพึ่ง emoji อย่างเดียว
  if (data.previousRejection) {
    cardBody.push({
      type: "Container",
      style: "attention",
      spacing: "Medium",
      items: [
        {
          type: "TextBlock",
          text: "⚠️ ใบนี้เคยถูกตีกลับ และถูกแก้ไขแล้วส่งกลับมาใหม่",
          weight: "Bolder",
          wrap: true
        },
        {
          type: "FactSet",
          spacing: "Small",
          facts: [
            { title: "ตีกลับโดย:", value: `${data.previousRejection.by} (${data.previousRejection.role})` },
            { title: "เมื่อ:", value: thaiDateTime(data.previousRejection.at) },
            { title: "เหตุผลเดิม:", value: data.previousRejection.reason },
          ]
        }
      ]
    });
  }

  // FactSet มาหลังป้ายเตือน — ป้ายต้องเป็นสิ่งแรกที่เห็นถัดจากหัวเรื่อง ไม่ใช่ถูกดันลงไป
  // ใต้ตารางข้อมูลจนกลายเป็นของที่ต้องกวาดตาหา
  cardBody.push({
    type: "FactSet",
    spacing: "Medium",
    facts: [
      { title: "Request ID:", value: data.requestId.toString() },
      { title: "PO Number:", value: data.poNumber },
      { title: "Vendor Name:", value: data.vendorName },
      { title: "PO Date:", value: data.poDate },
      { title: "Manager:", value: data.managerName },
      { title: "OwnerPR:", value: data.ownerPrName },
      { title: "RequestBy:", value: data.requestBy },
    ]
  });

  // 2. วนลูปตามจำนวน GRPO เพื่อสร้างปุ่ม Expand และตารางรายการ
  data.grpo.forEach((grpo, index) => {
    const sectionId = `grpoSection_${index}`;

    cardBody.push({
      type: "ActionSet",
      spacing: "Medium",
      actions: [
        {
          type: "Action.ToggleVisibility",
          title: `📦 ดูรายการ GRPO: ${grpo.grpoNumber} ⏷`,
          targetElements: [sectionId]
        }
      ]
    });

    // 2.2 สร้างหัวตารางสำหรับรายการย่อย (ปรับขนาดความกว้างให้พอดี 3 คอลัมน์)
    //
    // ⚠️ width ต้องเป็น "ตัวเลข" (น้ำหนักสัดส่วน) ไม่ใช่สตริง "40"
    // schema รับแค่ number, "auto", "stretch" หรือพิกเซล "40px" — สตริงตัวเลขเปล่า ๆ ไม่อยู่ในนั้น
    // แล้ว validator ของ flowbot ตีตกทั้งใบ (เคยเป็น "40" ทั้ง 6 ช่อง)
    const itemsList: any[] = [
      {
        type: "ColumnSet",
        columns: [
          { type: "Column", width: 40, items: [{ type: "TextBlock", text: "Description", weight: "Bolder" }] },
          { type: "Column", width: 30, items: [{ type: "TextBlock", text: "Price", weight: "Bolder", horizontalAlignment: "Right" }] },
          { type: "Column", width: 30, items: [{ type: "TextBlock", text: "Location", weight: "Bolder", horizontalAlignment: "Right" }] }
        ]
      }
    ];

    // 2.3 วนลูปดึงข้อมูล
    grpo.item.forEach((item) => {
      item.serialItems.forEach((serial) => {
        itemsList.push({
          type: "ColumnSet",
          spacing: "Small",
          columns: [
            { type: "Column", width: 40, items: [{ type: "TextBlock", text: item.description, wrap: true }] },
            { type: "Column", width: 30, items: [{ type: "TextBlock", text: serial.pricePerUnit.toLocaleString(), horizontalAlignment: "Right" }] },
            { type: "Column", width: 30, items: [{ type: "TextBlock", text: serial.location, wrap: true, horizontalAlignment: "Right" }] }
          ]
        });
      });
    });

    // padding ไม่ใช่ property ของ Container ใน Adaptive Cards (เป็นเรื่องของ host config)
    // ถอดออกแล้ว — renderer เดิมปล่อยผ่านแต่ validator ของ flowbot ไม่ปล่อย
    cardBody.push({
      type: "Container",
      id: sectionId,
      isVisible: false,
      style: "emphasis",
      items: itemsList
    });
  });

  // isRequired มีผลเฉพาะปุ่ม Reject — ปุ่ม Approve ตั้ง associatedInputs: "none" ไว้
  // จึงข้ามการตรวจช่องนี้ไปเลย (อนุมัติไม่ต้องพิมพ์อะไร)
  //
  // บังคับเฉพาะฝั่งตีกลับเพราะ rejectRequest() ต้องใช้ค่านี้เป็น rejectReason และคนกรอก
  // ต้องรู้ว่าต้องแก้อะไร ส่วนคอมเมนต์ตอนอนุมัติไม่มีคอลัมน์เก็บ บังคับไปก็ถูกทิ้ง
  cardBody.push(
    {
      type: "TextBlock",
      text: "💬 เหตุผล (บังคับกรอกเมื่อปฏิเสธ):",
      weight: "Bolder",
      spacing: "Medium"
    },
    {
      type: "Input.Text",
      id: "comments",
      placeholder: "ระบุเหตุผลในการอนุมัติ หรือ ปฏิเสธ...",
      isMultiline: true,
      isRequired: true,
      errorMessage: "กรุณาระบุความคิดเห็นก่อนส่ง"
    }
  );

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: cardBody,
    actions: [
      {
        type: "Action.Submit",
        title: "✅ Approve",
        style: "positive",
        // ข้ามการตรวจ input ทั้งหมด — อนุมัติไม่ต้องกรอกเหตุผล
        // (ผลข้างเคียงที่ตั้งใจ: comments จะไม่ถูกส่งมาด้วย webhook จึงต้องยอมรับค่าว่าง)
        associatedInputs: "none",
        data: {
          actionResult: "Approved",
          requestId: data.requestId
        }
      },
      {
        type: "Action.Submit",
        title: "❌ Reject",
        style: "destructive",
        data: {
          actionResult: "Rejected",
          requestId: data.requestId
        }
      }
    ]
  };
}


/** ยิงการ์ด + อีเมลขออนุมัติเข้า flow ของหัวหน้า */
export async function sendApprovalRequest(payload: ApprovalRequest): Promise<SendResult> {
  return postToFlow({
    url: managerFlowUrl(),
    envKey: 'POWER_AUTOMATE_URL',
    subject: 'การ์ดขออนุมัติ',
    body: {
      requestId: payload.requestId,
      managerId: payload.managerId,
      managerName: payload.managerName,
      managerEmail: payload.managerEmail,
      ownerPrName: payload.ownerPrName,
      requestBy: payload.requestBy,
      // ปลายทางของเมลแจ้งผลหลังหัวหน้ากด Approve — ส่งไปพร้อมใบตั้งแต่รอบขออนุมัติ
      // เพราะ flow ทำงานต่อจาก trigger เดิม ไม่ได้ย้อนกลับมาถาม AMS อีกรอบ
      requestByEmail: payload.requestByEmail,
      poNumber: payload.poNumber,
      vendorName: payload.vendorName,
      poDate: payload.poDate,
      // flow เอาไปใช้ต่อได้ (เช่น ใส่หัวเรื่องเมลว่า [ส่งใหม่]) — null = ส่งครั้งแรก
      previousRejection: payload.previousRejection,
      grpo: payload.grpo,
      emailHtml: buildApprovalEmailHtml(payload),
      adaptiveCard: buildAdaptiveCard(payload),
    },
  });
}
