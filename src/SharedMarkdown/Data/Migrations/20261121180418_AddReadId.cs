using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SharedMarkdown.Migrations
{
    /// <inheritdoc />
    public partial class AddReadId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ReadId",
                table: "Documents",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Documents_ReadId",
                table: "Documents",
                column: "ReadId",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Documents_ReadId",
                table: "Documents");

            migrationBuilder.DropColumn(
                name: "ReadId",
                table: "Documents");
        }
    }
}
