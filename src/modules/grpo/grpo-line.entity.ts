import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  type Relation,
} from 'typeorm';
import { PurchaseOrderItem } from '../purchase-order/purchase-order-item.entity';

// GRPO = หลักฐานว่ารับของเข้าคลังแล้ว — receivedQty คือเพดานจำนวน asset ที่ลงทะเบียนได้
@Entity('grpo_line')
export class GrpoLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 50 })
  grpoNo: string;

  @Column({ type: 'date' })
  grpoDate: string;

  @Column({ type: 'uuid' })
  poItemId: string;

  @Column({ type: 'int' })
  receivedQty: number;

  @ManyToOne(() => PurchaseOrderItem, (item) => item.grpoLines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'poItemId' })
  // Relation<> กัน circular import — ห้ามใส่ type entity ตรง ๆ ในความสัมพันธ์สองทาง
  poItem: Relation<PurchaseOrderItem>;
}
